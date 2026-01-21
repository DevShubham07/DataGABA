#!/bin/bash
# Test script for ML Trading Algorithm

echo "🧪 Testing ML Trading Algorithm"
echo "================================"
echo ""

# Test Case 1: Buy Up at low price (should execute)
echo "Test 1: Buy Up at $0.35 (low price, should execute)"
echo "----------------------------------------"
python3 src/services/mlTradingAlgorithm.py <<EOF
{
  "price": 0.35,
  "trader_side": "BUY",
  "trader_outcome": "Up",
  "trader_usdc_size": 5,
  "timestamp": 1704067200,
  "available_balance": 100
}
EOF

echo ""
echo ""

# Test Case 2: Buy Down at high price (should execute)
echo "Test 2: Buy Down at $0.65 (high price, should execute)"
echo "----------------------------------------"
python3 src/services/mlTradingAlgorithm.py <<EOF
{
  "price": 0.65,
  "trader_side": "BUY",
  "trader_outcome": "Down",
  "trader_usdc_size": 5,
  "timestamp": 1704067200,
  "available_balance": 100
}
EOF

echo ""
echo ""

# Test Case 3: Buy Up at high price (might skip)
echo "Test 3: Buy Up at $0.70 (high price, might skip)"
echo "----------------------------------------"
python3 src/services/mlTradingAlgorithm.py <<EOF
{
  "price": 0.70,
  "trader_side": "BUY",
  "trader_outcome": "Up",
  "trader_usdc_size": 5,
  "timestamp": 1704067200,
  "available_balance": 100
}
EOF

echo ""
echo ""

# Test Case 4: SELL order (should execute as-is)
echo "Test 4: SELL order (should execute as-is)"
echo "----------------------------------------"
python3 src/services/mlTradingAlgorithm.py <<EOF
{
  "price": 0.50,
  "trader_side": "SELL",
  "trader_usdc_size": 5,
  "timestamp": 1704067200,
  "available_balance": 100
}
EOF

echo ""
echo ""
echo "✅ Tests complete!"
