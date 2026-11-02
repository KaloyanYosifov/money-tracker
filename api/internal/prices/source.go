// Package prices fetches instrument prices and stores them for the app.
package prices

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound    = errors.New("prices: symbol not found")
	ErrRateLimited = errors.New("prices: rate limited")
)

// Kinds of an instrument. Search gives only stock, etf and crypto.
const (
	KindStock  = "stock"
	KindETF    = "etf"
	KindCrypto = "crypto"
	KindFX     = "fx"
)

type Match struct {
	Symbol   string
	Name     string
	Exchange string
	Kind     string
}

// DailyClose is the close of one day. Date is UTC midnight and Close is a
// decimal string.
type DailyClose struct {
	Date  time.Time
	Close string
}

// Chart is the data of one instrument. Latest is a decimal string in
// Currency.
type Chart struct {
	Symbol   string
	Name     string
	Exchange string
	Kind     string
	Currency string
	Closes   []DailyClose
	Latest   string
	LatestAt time.Time
}

// PriceSource gives instrument data. Chart returns the daily closes from the
// date of from to today.
type PriceSource interface {
	Search(ctx context.Context, query string) ([]Match, error)
	Chart(ctx context.Context, symbol string, from time.Time) (Chart, error)
}
