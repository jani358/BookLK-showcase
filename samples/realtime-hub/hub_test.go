package hub

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jani358/booklk/apps/realtime/internal/config"
	"github.com/jani358/booklk/apps/realtime/internal/metrics"
)

// testLogger discards output so test runs stay readable.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

func testConfig(sendBuffer int) *config.Config {
	return &config.Config{
		SendBufferSize: sendBuffer,
		PingInterval:   30 * time.Second,
		PongWait:       70 * time.Second,
		WriteWait:      10 * time.Second,
		MaxMessageSize: 4096,
	}
}

// newTestClient builds a Client with no real socket.
//
// The hub never touches conn during register/unregister/broadcast - only the
// pumps do, and these tests do not start them - so a nil conn exercises the
// registry logic in isolation.
func newTestClient(id string, h *Hub, sendBuffer int, topics ...string) *Client {
	return NewClient(id, nil, h, topics, nil, testConfig(sendBuffer), testLogger(), h.metrics)
}

// startHub runs a hub and returns it with a cancel func.
func startHub(t *testing.T) (*Hub, *metrics.Registry, context.CancelFunc) {
	t.Helper()
	m := metrics.New()
	h := New(testLogger(), m)
	ctx, cancel := context.WithCancel(context.Background())
	go h.Run(ctx)
	t.Cleanup(func() {
		cancel()
		select {
		case <-h.Done():
		case <-time.After(2 * time.Second):
			t.Error("hub did not shut down within 2s")
		}
	})
	return h, m, cancel
}

// waitForStats polls the hub snapshot until it matches or the deadline passes.
func waitForStats(t *testing.T, h *Hub, wantClients int) Stats {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var last Stats
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		s, ok := h.Snapshot(ctx)
		cancel()
		if ok {
			last = s
			if s.Clients == wantClients {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d clients, last snapshot: %+v", wantClients, last)
	return last
}

func TestHubRegisterAndUnregister(t *testing.T) {
	h, m, _ := startHub(t)

	c := newTestClient("c1", h, 8, VendorTopic("vendor-1"))
	if !h.Register(c) {
		t.Fatal("Register returned false on a running hub")
	}

	stats := waitForStats(t, h, 1)
	if stats.Topics != 1 {
		t.Errorf("topics = %d, want 1", stats.Topics)
	}
	if got := m.ConnectionsActive(); got != 1 {
		t.Errorf("connections_active = %d, want 1", got)
	}

	h.Unregister(c)
	stats = waitForStats(t, h, 0)

	// The topic set must be reclaimed once its last subscriber leaves, or the
	// map grows without bound over the life of the process.
	if stats.Topics != 0 {
		t.Errorf("topics = %d after last unregister, want 0", stats.Topics)
	}
	if got := m.ConnectionsActive(); got != 0 {
		t.Errorf("connections_active = %d, want 0", got)
	}
}

func TestHubUnregisterIsIdempotent(t *testing.T) {
	h, _, _ := startHub(t)

	c := newTestClient("c1", h, 8, VendorTopic("vendor-1"))
	h.Register(c)
	waitForStats(t, h, 1)

	// Both pumps defer Unregister, so a double unregister is the normal case
	// on every disconnect. It must not panic on the closed send channel.
	h.Unregister(c)
	h.Unregister(c)
	waitForStats(t, h, 0)
}

func TestHubBroadcastReachesOnlyTopicSubscribers(t *testing.T) {
	h, _, _ := startHub(t)

	a1 := newTestClient("a1", h, 8, VendorTopic("vendor-a"))
	a2 := newTestClient("a2", h, 8, VendorTopic("vendor-a"))
	b1 := newTestClient("b1", h, 8, VendorTopic("vendor-b"))

	for _, c := range []*Client{a1, a2, b1} {
		h.Register(c)
	}
	waitForStats(t, h, 3)

	payload := []byte(`{"type":"slot.updated","vendorId":"vendor-a"}`)
	if !h.Broadcast(VendorTopic("vendor-a"), payload) {
		t.Fatal("Broadcast returned false")
	}

	for _, c := range []*Client{a1, a2} {
		select {
		case got := <-c.send:
			if string(got) != string(payload) {
				t.Errorf("client %s got %q, want %q", c.ID(), got, payload)
			}
		case <-time.After(time.Second):
			t.Errorf("client %s did not receive the broadcast", c.ID())
		}
	}

	// Isolation between vendors is the core correctness property: one vendor's
	// bookings must never leak to another vendor's watchers.
	select {
	case got := <-b1.send:
		t.Errorf("vendor-b subscriber wrongly received %q", got)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestHubBroadcastToUnknownTopicIsNoop(t *testing.T) {
	h, m, _ := startHub(t)

	c := newTestClient("c1", h, 8, VendorTopic("vendor-a"))
	h.Register(c)
	waitForStats(t, h, 1)

	h.Broadcast(VendorTopic("nobody-here"), []byte(`{}`))
	// Give the hub a chance to process before asserting nothing happened.
	waitForStats(t, h, 1)

	select {
	case got := <-c.send:
		t.Errorf("client received %q for a topic it is not subscribed to", got)
	default:
	}
	if got := m.MessagesSent(); got != 0 {
		t.Errorf("messages_sent = %d, want 0", got)
	}
}

func TestHubDropsSlowConsumerInsteadOfBlocking(t *testing.T) {
	h, m, _ := startHub(t)

	const bufSize = 4
	topic := VendorTopic("vendor-busy")

	// slow never drains its send channel; healthy is read on every broadcast.
	slow := newTestClient("slow", h, bufSize, topic)
	healthy := newTestClient("healthy", h, 64, topic)

	h.Register(slow)
	h.Register(healthy)
	waitForStats(t, h, 2)

	// Overflow the slow client's buffer several times over. If the hub blocked
	// on a full send channel this loop would deadlock and the test would hang.
	const sends = bufSize * 10
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < sends; i++ {
			h.Broadcast(topic, []byte(fmt.Sprintf(`{"n":%d}`, i)))
			// Keep the healthy client drained so it is never itself a
			// slow consumer.
			select {
			case <-healthy.send:
			default:
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hub blocked on a slow consumer - broadcasts did not complete")
	}

	// The slow client must be evicted, leaving the healthy one connected.
	stats := waitForStats(t, h, 1)
	if stats.Clients != 1 {
		t.Fatalf("clients = %d, want 1 (slow consumer should be dropped)", stats.Clients)
	}

	if got := m.MessagesDropped(); got == 0 {
		t.Error("messages_dropped_total = 0, want > 0 for a dropped slow consumer")
	}

	// The healthy client must still be receiving after the eviction.
	h.Broadcast(topic, []byte(`{"after":"eviction"}`))
	select {
	case <-healthy.send:
	case <-time.After(time.Second):
		t.Error("healthy client stopped receiving after the slow consumer was dropped")
	}
}

func TestHubClientWithMultipleTopics(t *testing.T) {
	h, _, _ := startHub(t)

	c := newTestClient("multi", h, 8, VendorTopic("v1"), VendorTopic("v2"))
	h.Register(c)

	stats := waitForStats(t, h, 1)
	if stats.Topics != 2 {
		t.Fatalf("topics = %d, want 2", stats.Topics)
	}

	h.Broadcast(VendorTopic("v1"), []byte(`{"t":"v1"}`))
	h.Broadcast(VendorTopic("v2"), []byte(`{"t":"v2"}`))

	for i := 0; i < 2; i++ {
		select {
		case <-c.send:
		case <-time.After(time.Second):
			t.Fatalf("expected 2 messages, got %d", i)
		}
	}

	// Unregistering must clean the client out of BOTH topic indexes.
	h.Unregister(c)
	stats = waitForStats(t, h, 0)
	if stats.Topics != 0 {
		t.Errorf("topics = %d after unregister, want 0", stats.Topics)
	}
}

func TestHubRejectsOperationsAfterShutdown(t *testing.T) {
	m := metrics.New()
	h := New(testLogger(), m)
	ctx, cancel := context.WithCancel(context.Background())
	go h.Run(ctx)

	c := newTestClient("c1", h, 8, VendorTopic("v1"))
	h.Register(c)
	waitForStats(t, h, 1)

	cancel()
	select {
	case <-h.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("hub did not shut down")
	}

	// Post-shutdown calls must return cleanly rather than blocking forever.
	if h.Register(newTestClient("c2", h, 8, VendorTopic("v1"))) {
		t.Error("Register returned true after shutdown")
	}
	if h.Broadcast(VendorTopic("v1"), []byte(`{}`)) {
		t.Error("Broadcast returned true after shutdown")
	}
	h.Unregister(c) // must not block

	if got := m.ConnectionsActive(); got != 0 {
		t.Errorf("connections_active = %d after shutdown, want 0", got)
	}
}

// TestHubConcurrentRegisterUnregisterBroadcast is the race-detector workhorse.
//
// Run with `go test -race`. It hammers the hub from many goroutines at once;
// because the topic map is owned exclusively by the Run goroutine, the detector
// should find no conflicting access at all.
func TestHubConcurrentRegisterUnregisterBroadcast(t *testing.T) {
	h, _, _ := startHub(t)

	const (
		clients    = 100
		vendors    = 10
		broadcasts = 200
	)

	var wg sync.WaitGroup

	// Broadcasters run concurrently with the churn below.
	for b := 0; b < 4; b++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < broadcasts; i++ {
				topic := VendorTopic(fmt.Sprintf("vendor-%d", i%vendors))
				h.Broadcast(topic, []byte(fmt.Sprintf(`{"b":%d,"i":%d}`, id, i)))
			}
		}(b)
	}

	// 100 clients registering, draining, and unregistering concurrently.
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()

			c := newTestClient(
				fmt.Sprintf("c%d", i), h, 16,
				VendorTopic(fmt.Sprintf("vendor-%d", i%vendors)),
			)
			if !h.Register(c) {
				return
			}

			// Drain so this client is not evicted as a slow consumer mid-test.
			//
			// Ranging over the channel (rather than selecting on it) is what
			// makes this terminate: range exits exactly when the hub closes the
			// send channel, which it always does on unregister or eviction. A
			// select with a stop-channel case could keep choosing the ready
			// closed-channel case and spin forever.
			drained := make(chan struct{})
			go func() {
				defer close(drained)
				for range c.send { //nolint:revive // draining only
				}
			}()

			time.Sleep(time.Duration(i%5) * time.Millisecond)
			h.Unregister(c)

			// Bounded wait: if the hub ever failed to close the send channel,
			// fail loudly instead of hanging the whole suite until timeout.
			select {
			case <-drained:
			case <-time.After(10 * time.Second):
				t.Errorf("client %d: send channel was never closed by the hub", i)
			}
		}(i)
	}

	wg.Wait()

	// Every client unregistered, so the registry must be empty - proving no
	// registration was lost or double-counted under concurrency.
	waitForStats(t, h, 0)
}

func TestOriginChecker(t *testing.T) {
	m := metrics.New()

	tests := []struct {
		name    string
		allowed []string
		origin  string
		want    bool
	}{
		{"exact match", []string{"https://booklk.lk"}, "https://booklk.lk", true},
		{"trailing slash in allow-list", []string{"https://booklk.lk/"}, "https://booklk.lk", true},
		{"case insensitive host", []string{"https://booklk.lk"}, "https://BookLK.LK", true},
		{"second entry matches", []string{"http://localhost:3000", "https://booklk.lk"}, "https://booklk.lk", true},
		{"disallowed origin", []string{"https://booklk.lk"}, "https://evil.com", false},
		{"scheme mismatch", []string{"https://booklk.lk"}, "http://booklk.lk", false},
		{"port mismatch", []string{"http://localhost:3000"}, "http://localhost:4000", false},
		{"prefix attack", []string{"https://booklk.lk"}, "https://booklk.lk.evil.com", false},
		{"non-browser client", []string{"https://booklk.lk"}, "", true},
		{"wildcard allows all", []string{"*"}, "https://anything.com", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &config.Config{AllowedOrigins: tt.allowed}
			check := originChecker(cfg, m, testLogger())

			r := httptest.NewRequest(http.MethodGet, "/ws?vendorId=v1", nil)
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}

			if got := check(r); got != tt.want {
				t.Errorf("CheckOrigin(%q) with allow-list %v = %v, want %v",
					tt.origin, tt.allowed, got, tt.want)
			}
		})
	}
}

func TestVendorTopic(t *testing.T) {
	if got, want := VendorTopic("abc"), "vendor:abc"; got != want {
		t.Errorf("VendorTopic = %q, want %q", got, want)
	}
}

func TestClientTrySendAfterClose(t *testing.T) {
	h, _, _ := startHub(t)
	c := newTestClient("c1", h, 2, VendorTopic("v1"))

	if !c.trySend([]byte(`{}`)) {
		t.Fatal("trySend failed on an open client")
	}

	c.closeSend()
	// Closing twice must be safe - the hub and both pumps can all race here.
	c.closeSend()

	// Must report failure rather than panicking with "send on closed channel".
	if c.trySend([]byte(`{}`)) {
		t.Error("trySend returned true on a closed client")
	}
}
