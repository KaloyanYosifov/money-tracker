// Package metrics serves counters in the Prometheus text format.
package metrics

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// CounterVec is a counter with one value for each combination of label values.
type CounterVec struct {
	name   string
	help   string
	labels []string

	mu     sync.Mutex
	counts map[string]uint64
}

var (
	registryMu sync.Mutex
	registry   []*CounterVec
)

// NewCounterVec makes a counter and adds it to the output of Handler.
func NewCounterVec(name, help string, labels ...string) *CounterVec {
	c := &CounterVec{name: name, help: help, labels: labels, counts: map[string]uint64{}}
	registryMu.Lock()
	registry = append(registry, c)
	registryMu.Unlock()
	return c
}

// Init shows the series with the value 0, so that the first Inc is an increase.
func (c *CounterVec) Init(values ...string) { c.add(values, 0) }

// Inc adds 1 to the series of values.
func (c *CounterVec) Inc(values ...string) { c.add(values, 1) }

// Value returns the count of the series of values.
func (c *CounterVec) Value(values ...string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.counts[c.key(values)]
}

func (c *CounterVec) add(values []string, n uint64) {
	k := c.key(values)
	c.mu.Lock()
	c.counts[k] += n
	c.mu.Unlock()
}

func (c *CounterVec) key(values []string) string {
	if len(values) != len(c.labels) {
		panic(fmt.Sprintf("metrics: %s has %d labels, got %d values", c.name, len(c.labels), len(values)))
	}
	pairs := make([]string, len(values))
	for i, v := range values {
		pairs[i] = c.labels[i] + "=" + strconv.Quote(v)
	}
	return strings.Join(pairs, ",")
}

func (c *CounterVec) write(b *strings.Builder) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s counter\n", c.name, c.help, c.name)
	keys := make([]string, 0, len(c.counts))
	for k := range c.counts {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		fmt.Fprintf(b, "%s{%s} %d\n", c.name, k, c.counts[k])
	}
}

// Handler serves all counters.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b strings.Builder
		registryMu.Lock()
		for _, c := range registry {
			c.write(&b)
		}
		registryMu.Unlock()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(b.String()))
	})
}
