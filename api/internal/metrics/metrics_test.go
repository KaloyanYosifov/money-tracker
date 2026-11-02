package metrics

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler(t *testing.T) {
	c := NewCounterVec("test_requests_total", "Requests of the test.", "endpoint", "result")
	c.Init("chart", "ok")
	c.Init("chart", "error")
	c.Inc("chart", "ok")
	c.Inc("chart", "ok")
	c.Inc("search", `a"b`)

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body, _ := io.ReadAll(rec.Body)

	want := `# HELP test_requests_total Requests of the test.
# TYPE test_requests_total counter
test_requests_total{endpoint="chart",result="error"} 0
test_requests_total{endpoint="chart",result="ok"} 2
test_requests_total{endpoint="search",result="a\"b"} 1
`
	if !strings.Contains(string(body), want) {
		t.Errorf("body =\n%s\nwant it to contain\n%s", body, want)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain; version=0.0.4") {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestIncWrongLabelCount(t *testing.T) {
	c := &CounterVec{name: "x", labels: []string{"a"}, counts: map[string]uint64{}}
	defer func() {
		if recover() == nil {
			t.Error("Inc with a wrong value count did not panic")
		}
	}()
	c.Inc("a", "b")
}
