package portfolio

import "math/big"

// Swap is a swap row. Fee is in units of the "to" asset, Value is in the "from" quote currency and ToValue in the "to" quote currency.
type Swap struct {
	ID           string
	Date         string
	FromQuantity string
	ToQuantity   string
	Fee          string
	Value        string
	ToValue      string
}

// SwapLegs turns a swap into a sell of the "from" asset and a buy of the "to" asset.
func SwapLegs(s Swap) (sell, buy Trade) {
	fee := value(s.Fee)
	toValue := value(s.ToValue)
	feePart := new(big.Int)
	if fee.Sign() != 0 {
		feePart = Div(Mul(fee, toValue), new(big.Int).Add(value(s.ToQuantity), fee))
	}
	sell = Trade{ID: s.ID, Side: "sell", Date: s.Date, Quantity: s.FromQuantity, Price: "0", Fee: "0", Total: s.Value}
	buy = Trade{ID: s.ID, Side: "buy", Date: s.Date, Quantity: s.ToQuantity, Price: "0", Fee: FormatFixed(feePart), Total: FormatFixed(new(big.Int).Sub(toValue, feePart))}
	return sell, buy
}
