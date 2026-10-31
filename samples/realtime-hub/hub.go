// From apps/realtime/internal/hub/hub.go in github.com/jani358/BookLK.

// Package hub implements the connection registry and fan-out engine.
//
// Concurrency model
// -----------------
// The topic map is owned by exactly one goroutine (Hub.Run). Every mutation -
// register, unregister, broadcast - arrives as a message on a channel and is
// applied by that single goroutine. Nothing else ever touches the map.
//
// This is the "share memory by communicating" idiom, and it is chosen over a
// sync.RWMutex deliberately. A mutex-guarded map is correct too, but every
// broadcast would hold the read lock for the whole fan-out loop, so a single
// slow client could stall registration for everyone. Serialising through one
// goroutine also makes the code trivially race-free: `go test -race` has no
// interleaving to find because there is only ever one accessor.
package hub

import (
	"context"
	"log/slog"
	"runtime/debug"
	"sync"

	"github.com/jani358/booklk/apps/realtime/internal/metrics"
)

// TopicPrefixVendor namespaces per-vendor availability topics.
const TopicPrefixVendor = "vendor:"

// VendorTopic builds the topic name for a vendor's availability stream.
func VendorTopic(vendorID string) string { return TopicPrefixVendor + vendorID }

// Broadcast is a payload destined for every client subscribed to Topic.
type Broadcast struct {
	Topic   string
	Payload []byte
}

// Stats is a point-in-time snapshot of the registry.
type Stats struct {
	Clients int `json:"clients"`
	Topics  int `json:"topics"`
}

// Hub owns the topic -> clients registry and fans messages out to clients.
type Hub struct {
	// topics maps a topic name to the set of clients subscribed to it.
	// GUARDED BY: exclusive ownership by the Run goroutine. Never lock it,
	// never read it from another goroutine - send a message instead.
	topics map[string]map[*Client]bool

	// clients is the set of all connected clients, used for shutdown fan-out.
	clients map[*Client]bool

	// pendingUnregister holds clients whose unregister was processed before
	// their register arrived. See addClient for why this is necessary. Entries
	// are short-lived: each is consumed by the matching addClient.
	pendingUnregister map[*Client]bool

	register   chan *Client
	unregister chan *Client
	broadcast  chan Broadcast
	statsReq   chan chan Stats

	// done is closed once Run has fully exited and all clients are closed.
	done chan struct{}

	logger  *slog.Logger
	metrics *metrics.Registry

	// closeOnce guards the shutdown path so a double Run exit cannot
	// double-close done.
	closeOnce sync.Once
}

// New constructs a Hub. Call Run in its own goroutine to start it.
func New(logger *slog.Logger, m *metrics.Registry) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	if m == nil {
		m = metrics.New()
	}
	return &Hub{
		topics:            make(map[string]map[*Client]bool),
		clients:           make(map[*Client]bool),
		pendingUnregister: make(map[*Client]bool),
		register:          make(chan *Client, 64),
		unregister:        make(chan *Client, 64),
		broadcast:         make(chan Broadcast, 256),
		statsReq:          make(chan chan Stats, 8),
		done:              make(chan struct{}),
		logger:            logger,
		metrics:           m,
	}
}

// Run is the hub's event loop and the sole owner of the topic map.
//
// It returns when ctx is cancelled, after closing every live connection.
func (h *Hub) Run(ctx context.Context) {
	// A panic in ANY goroutine that is not recovered terminates the entire Go
	// process - there is no per-goroutine isolation like a thread pool in a JVM
	// or a request handler in Node. The hub goroutine is the single most
	// critical one in the service, so it gets an explicit guard: a malformed
	// payload must never take down the other 10,000 healthy connections.
	defer func() {
		if r := recover(); r != nil {
			h.metrics.IncPanicsRecovered()
			h.logger.Error("panic recovered in hub run loop",
				slog.Any("panic", r),
				slog.String("stack", string(debug.Stack())))
		}
		// Whether we exited cleanly or via panic, every connection must be
		// released or their goroutines would leak for the life of the process.
		h.shutdown()
	}()

	for {
		select {
		case <-ctx.Done():
			h.logger.Info("hub shutting down", slog.Int("clients", len(h.clients)))
			return

		case c := <-h.register:
			h.addClient(c)

		case c := <-h.unregister:
			h.removeClient(c)

		case b := <-h.broadcast:
			h.dispatch(b)

		case reply := <-h.statsReq:
			// Computed on the owning goroutine, so the snapshot is consistent
			// and needs no lock.
			reply <- Stats{Clients: len(h.clients), Topics: len(h.topics)}
		}
	}
}

// addClient records a client and indexes it under each of its topics.
func (h *Hub) addClient(c *Client) {
	if h.clients[c] {
		return
	}

	// A select over several ready channels chooses at random, so an unregister
	// can be delivered BEFORE the register for the same client - a real race
	// for a connection that drops immediately after opening. removeClient would
	// then find nothing to do, and this addClient would insert a client nobody
	// will ever remove: a permanent map entry plus a send channel that is never
	// closed, so its writePump blocks forever. Honouring the early unregister
	// here closes that leak.
	if h.pendingUnregister[c] {
		delete(h.pendingUnregister, c)
		c.closeSend()
		return
	}

	h.clients[c] = true
	for _, topic := range c.Topics() {
		subs, ok := h.topics[topic]
		if !ok {
			subs = make(map[*Client]bool)
			h.topics[topic] = subs
		}
		subs[c] = true
	}
	h.metrics.IncConnections()
	h.logger.Debug("client registered",
		slog.String("client_id", c.ID()),
		slog.Any("topics", c.Topics()),
		slog.Int("total_clients", len(h.clients)))
}

// removeClient unindexes a client and closes its send channel.
func (h *Hub) removeClient(c *Client) {
	if !h.clients[c] {
		// Either already removed - Unregister can legitimately arrive twice,
		// since both pumps defer it - or this unregister overtook the client's
		// own register. Recording it lets addClient detect the latter and drop
		// the client instead of resurrecting it.
		h.pendingUnregister[c] = true
		return
	}
	delete(h.clients, c)
	delete(h.pendingUnregister, c)

	for _, topic := range c.Topics() {
		if subs, ok := h.topics[topic]; ok {
			delete(subs, c)
			// Drop empty topic sets so the map does not grow without bound as
			// vendors come and go over a long-lived process.
			if len(subs) == 0 {
				delete(h.topics, topic)
			}
		}
	}

	c.closeSend()
	h.metrics.DecConnections()
	h.logger.Debug("client unregistered",
		slog.String("client_id", c.ID()),
		slog.Int("total_clients", len(h.clients)))
}

// dispatch fans one broadcast out to every subscriber of its topic.
func (h *Hub) dispatch(b Broadcast) {
	subs, ok := h.topics[b.Topic]
	if !ok || len(subs) == 0 {
		return
	}

	var dropped []*Client
	var sent int64

	for c := range subs {
		// Non-blocking send. If the client's buffer is full it is a slow
		// consumer: its network is too slow, or its browser tab is throttled.
		// Blocking here would let one bad connection stall the hub goroutine
		// and therefore every other client's updates. Instead we drop it and
		// let the client reconnect and re-sync via the REST API.
		if c.trySend(b.Payload) {
			sent++
			continue
		}
		dropped = append(dropped, c)
	}

	if sent > 0 {
		h.metrics.AddMessagesSent(sent)
	}

	for _, c := range dropped {
		h.metrics.AddMessagesDropped(1)
		h.metrics.IncSlowConsumers()
		h.logger.Warn("dropping slow consumer",
			slog.String("client_id", c.ID()),
			slog.String("topic", b.Topic))
		// Safe to call inside the Run goroutine: removeClient mutates the map
		// directly rather than sending on h.unregister, which would deadlock.
		h.removeClient(c)
	}
}

// shutdown closes every remaining client connection exactly once.
func (h *Hub) shutdown() {
	h.closeOnce.Do(func() {
		for c := range h.clients {
			delete(h.clients, c)
			c.closeSend()
			h.metrics.DecConnections()
		}
		h.topics = make(map[string]map[*Client]bool)
		h.pendingUnregister = make(map[*Client]bool)

		// Drain clients that won the race in Register - they passed the
		// shutdown check and enqueued just before we stopped reading. Without
		// this their send channels are never closed, so their writePumps block
		// forever and the connections leak for the life of the process.
		for {
			select {
			case c := <-h.register:
				c.closeSend()
			default:
				close(h.done)
				return
			}
		}
	})
}

// Done returns a channel closed once the hub has fully stopped.
func (h *Hub) Done() <-chan struct{} { return h.done }

// Register enqueues a client for registration.
//
// It returns false if the hub is already shutting down, letting the caller
// close the connection instead of leaking it.
func (h *Hub) Register(c *Client) bool {
	// Shutdown is checked first and separately, for the same reason as in
	// Broadcast: a combined select would resolve the tie at random and admit
	// clients to a hub that will never register them.
	select {
	case <-h.done:
		return false
	default:
	}

	select {
	case h.register <- c:
		return true
	case <-h.done:
		return false
	}
}

// Unregister enqueues a client for removal. It never blocks on a stopped hub.
func (h *Hub) Unregister(c *Client) {
	select {
	case h.unregister <- c:
	case <-h.done:
	}
}

// Broadcast enqueues a payload for fan-out to a topic.
//
// It returns false if the hub is stopped or its broadcast queue is saturated.
// Dropping here is intentional back-pressure: if the hub cannot keep up, the
// correct response is to shed load and record it, not to grow an unbounded
// queue until the process is OOM-killed.
func (h *Hub) Broadcast(topic string, payload []byte) bool {
	// Check for shutdown FIRST, in its own select. A single select with both a
	// ready buffered-channel case and a closed done case picks between them at
	// random, so a stopped hub would still accept messages roughly half the
	// time - they would sit in the buffer forever with no Run loop to drain them.
	select {
	case <-h.done:
		return false
	default:
	}

	select {
	case h.broadcast <- Broadcast{Topic: topic, Payload: payload}:
		return true
	case <-h.done:
		return false
	default:
		h.metrics.AddMessagesDropped(1)
		h.logger.Warn("hub broadcast queue full, dropping message",
			slog.String("topic", topic))
		return false
	}
}

// Snapshot asks the Run goroutine for a consistent view of the registry.
//
// This keeps the "one goroutine owns the map" invariant intact: callers do not
// read the map, they ask its owner for a copy.
func (h *Hub) Snapshot(ctx context.Context) (Stats, bool) {
	reply := make(chan Stats, 1)
	select {
	case h.statsReq <- reply:
	case <-ctx.Done():
		return Stats{}, false
	case <-h.done:
		return Stats{}, false
	}
	select {
	case s := <-reply:
		return s, true
	case <-ctx.Done():
		return Stats{}, false
	case <-h.done:
		return Stats{}, false
	}
}
