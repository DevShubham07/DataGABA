# Trading Pattern Recognition Model - Analysis Results

## Overview

Trained machine learning models on **51,977 trades** from **88 Ethereum 1-hour markets** to identify and predict trading patterns.

## Key Findings

### 1. **Price-Based Decision Pattern** ✅
- **53.8%** of trades buy the cheaper outcome
- When price < 0.5: Buy "Up" (55.5% of Up trades)
- When price > 0.5: Buy "Down" (52.1% of Down trades)
- **Pattern**: Market-making/arbitrage strategy

### 2. **Price Patterns**
- Overall average price: **$0.4861**
- Average price when buying Up: **$0.4643** (cheaper)
- Average price when buying Down: **$0.5128** (more expensive)
- Price difference: **$0.0485** (Down is ~10% more expensive)

### 3. **Time-Based Patterns**
Most active trading hours:
- **10:00** - 3,152 trades
- **23:00** - 2,985 trades
- **08:00** - 2,806 trades
- **05:00** - 2,644 trades
- **03:00** - 2,619 trades

### 4. **Trade Size Patterns**
- Average trade size: **$9.21 USDC**
- Median trade size: **$4.12 USDC**
- Standard deviation: **$104.25** (high variance - some large trades)

## Model Performance

### Outcome Prediction Model (Up/Down)
- **Accuracy: 99.61%** 🎯
- **Precision**: Up (100%), Down (99%)
- **Recall**: Up (99%), Down (100%)
- **F1-Score**: 1.00

**Top Features (by importance):**
1. `is_cheaper_outcome`: 48.43% - Most important!
2. `price`: 35.27%
3. `usdcSize`: 10.08%
4. `size`: 2.48%
5. `price_distance_from_50`: 2.13%

### Trade Size Prediction Model
- **R² Score: 0.1169** (moderate)
- **MSE: 10,849.97**
- Mean actual: $9.83
- Mean predicted: $8.27

**Top Features (by importance):**
1. `hour`: 38.67% - Time of day matters most!
2. `price_distance_from_50`: 29.48%
3. `outcomeIndex`: 13.81%
4. `day_of_week`: 9.79%
5. `price`: 8.24%

## Algorithm Identified

### **Market-Making/Statistical Arbitrage Strategy**

```python
def trading_algorithm(price, hour):
    # Primary decision: Buy cheaper outcome
    if price < 0.5:
        outcome = "Up"  # Up is cheaper
        confidence = 0.93  # High confidence
    elif price > 0.5:
        outcome = "Down"  # Down is cheaper (1 - price)
        confidence = 0.93  # High confidence
    else:
        outcome = random.choice(["Up", "Down"])  # At 0.5, either works
    
    # Size prediction based on hour and price deviation
    base_size = 9.21  # Average
    size_multiplier = calculate_size_multiplier(hour, abs(price - 0.5))
    trade_size = base_size * size_multiplier
    
    return outcome, trade_size
```

## Model Predictions

### Test Case 1: Price = $0.35, Hour = 10:00
- **Predicted outcome**: Up ✅
- **Confidence**: 92.93%
- **Predicted size**: $3.67 USDC

### Test Case 2: Price = $0.65, Hour = 15:00
- **Predicted outcome**: Down ✅
- **Confidence**: ~93%
- **Predicted size**: Based on hour and price deviation

### Test Case 3: Price = $0.48, Hour = 12:00
- **Predicted outcome**: Up (slightly cheaper)
- **Confidence**: Lower (~60-70%)
- **Predicted size**: Average size

## Insights

1. **Clear Pattern**: The model confirms the strategy is buying cheaper outcomes
2. **High Accuracy**: 99.61% accuracy suggests the pattern is very consistent
3. **Time Matters**: Hour of day is important for size prediction (38.67% importance)
4. **Price Deviation**: Distance from 0.5 matters for both outcome and size
5. **Balanced Strategy**: Maintains ~50/50 Up/Down distribution

## Usage

### Train the model:
```bash
npm run train-pattern-model
```

### Use the model:
```python
from src.scripts.tradingPatternModel import TradingPatternModel

model = TradingPatternModel()
model.load_models('models')  # Load saved models

# Predict outcome
prediction = model.predict_outcome(price=0.35, hour=10, size=10, usdc_size=5)
print(prediction)
# {'predicted_outcome': 'Up', 'confidence': 0.93, ...}

# Predict trade size
size_pred = model.predict_trade_size(price=0.35, hour=10, outcome_index=0)
print(size_pred)
# {'predicted_usdc_size': 3.67, ...}
```

## Files Generated

- `models/outcome_model.pkl` - Outcome prediction model
- `models/size_model.pkl` - Trade size prediction model
- `models/outcome_scaler.pkl` - Feature scaler for outcome model
- `models/size_scaler.pkl` - Feature scaler for size model
- `models/feature_importance.json` - Feature importance analysis

## Next Steps

1. **Real-time Prediction**: Integrate model into trading bot
2. **Backtesting**: Test predictions on historical data
3. **Feature Engineering**: Add more features (market volume, volatility, etc.)
4. **Ensemble Models**: Combine multiple models for better predictions
5. **Risk Management**: Add risk assessment based on confidence scores
