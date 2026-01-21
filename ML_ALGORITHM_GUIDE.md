# ML Trading Algorithm Guide

## Overview

The ML Trading Algorithm uses trained machine learning models to make intelligent trading decisions. It analyzes market conditions, predicts outcomes, and recommends trade sizes based on patterns learned from historical data.

## Features

### 1. **Outcome Prediction**
- Predicts whether to buy "Up" or "Down" based on:
  - Current market price
  - Time-series features (volatility, momentum, trends)
  - Market timing and context
  - Historical patterns

### 2. **Trade Size Recommendation**
- Recommends optimal trade size based on:
  - Market conditions
  - Price levels
  - Historical size patterns
  - Available balance

### 3. **Decision Logic**
The algorithm implements multiple decision rules:

- **ML Confidence Threshold**: Requires 85%+ confidence to execute
- **Cheaper Outcome Preference**: Favors buying cheaper outcomes (pattern match)
- **Time-Based Filtering**: Prefers active trading hours (3, 5, 8, 10, 23)
- **Outcome Matching**: Checks if trader's outcome matches ML prediction
- **Size Validation**: Ensures recommended size is within limits

## How It Works

### Decision Flow

```
1. Load ML Models (if not already loaded)
   ↓
2. Extract Market Features
   - Price, timestamp, trader info
   - Time-series features
   - Market context
   ↓
3. Predict Outcome
   - Use trained model to predict Up/Down
   - Get confidence score
   ↓
4. Validate Decision
   - Check confidence threshold
   - Verify cheaper outcome preference
   - Check active trading hours
   - Match trader's outcome
   ↓
5. Recommend Size
   - Use ML model to predict optimal size
   - Apply safety limits
   ↓
6. Return Decision
   - Execute: true/false
   - Reason: explanation
   - Recommended size
```

## Integration

The algorithm is automatically integrated into the trading bot. It runs before each BUY order execution.

### Enable/Disable

Set environment variable:
```bash
ML_ALGORITHM_ENABLED=true   # Enable (default)
ML_ALGORITHM_ENABLED=false  # Disable
```

### How It Affects Trading

1. **Before Order Execution**: Algorithm analyzes the trade
2. **Decision**: Can skip trades that don't meet criteria
3. **Size Adjustment**: Can adjust order size based on ML recommendations
4. **Logging**: All decisions are logged with reasoning

## Algorithm Rules

### Rule 1: Confidence Threshold
- **Requires**: 85%+ ML confidence
- **Action**: Skip if below threshold (unless other strong signals)

### Rule 2: Cheaper Outcome Preference
- **Pattern**: 53.8% of historical trades buy cheaper outcome
- **Action**: Favors buying cheaper outcome
- **Impact**: Reduces confidence if buying expensive outcome

### Rule 3: Active Trading Hours
- **Active Hours**: 3, 5, 8, 10, 23 (most active)
- **Action**: Slightly reduces confidence outside active hours
- **Impact**: More conservative during inactive hours

### Rule 4: Outcome Matching
- **Check**: Does trader's outcome match ML prediction?
- **Action**: If mismatch, requires higher confidence (95%+)
- **Impact**: More selective when outcomes differ

### Rule 5: Size Validation
- **Minimum**: $1 USD
- **Maximum**: 95% of available balance
- **Recommendation**: Uses ML predicted size or trader size (whichever is more appropriate)

## Usage Examples

### Python CLI

```bash
# Test with sample data
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
```

### TypeScript Integration

```typescript
import { getMLAlgorithm, MarketData } from './services/mlTradingAlgorithm';

const mlAlgorithm = getMLAlgorithm(true);

const marketData: MarketData = {
    price: 0.35,
    trader_side: 'BUY',
    trader_outcome: 'Up',
    trader_usdc_size: 5,
    timestamp: Math.floor(Date.now() / 1000),
    available_balance: 100,
};

const decision = await mlAlgorithm.shouldExecuteTrade(marketData);

if (decision.execute) {
    console.log(`Execute trade: $${decision.recommended_size_usd}`);
    console.log(`Confidence: ${decision.confidence * 100}%`);
} else {
    console.log(`Skip trade: ${decision.reason}`);
}
```

## Decision Output

The algorithm returns a decision object:

```typescript
{
    execute: boolean,              // Should we execute?
    reason: string,                 // Explanation
    predicted_outcome: 'Up'|'Down'|null,  // ML prediction
    confidence: number,             // Overall confidence (0-1)
    recommended_size_usd: number,   // Recommended size
    ml_confidence: number,         // ML model confidence (0-1)
    is_cheaper_outcome: boolean,    // Buying cheaper?
    is_active_hour: boolean,        // Active trading hour?
    outcome_match: boolean          // Trader matches ML?
}
```

## Performance Metrics

Based on training results:

- **Outcome Prediction Accuracy**: 99.45%
- **Top Feature Importance**: `is_cheaper_outcome` (83.89%)
- **Pattern Match**: 53.8% of trades buy cheaper outcome
- **Average Trade Size**: $4.58 USDC

## Configuration

### Model Location
Models are loaded from `models/` directory:
- `outcome_model.pkl` - Outcome prediction model
- `size_model.pkl` - Size prediction model
- `outcome_scaler.pkl` - Feature scaler
- `size_scaler.pkl` - Size scaler
- `outcome_label_encoder.pkl` - Label encoder
- `discovered_patterns.json` - Trading patterns

### Customization

You can modify decision thresholds in `mlTradingAlgorithm.py`:

```python
# Confidence threshold
min_confidence = 0.85  # Change to adjust sensitivity

# Active hours
active_hours = [3, 5, 8, 10, 23]  # Modify as needed

# Size limits
min_size = 1.0  # Minimum trade size
max_size_ratio = 0.95  # Max % of balance
```

## Troubleshooting

### Models Not Found
```
Error: Model files not found in models/
```
**Solution**: Run training first:
```bash
npm run train-pattern-model
```

### Python Process Errors
```
Failed to spawn Python process
```
**Solution**: 
- Ensure Python 3 is installed
- Check Python path: `which python3`
- Verify script permissions: `chmod +x src/services/mlTradingAlgorithm.py`

### Low Confidence Decisions
If algorithm skips too many trades:
- Lower `min_confidence` threshold
- Adjust active hours list
- Review pattern matching logic

### High Confidence but Wrong Predictions
- Retrain models with more recent data
- Review feature importance
- Check for data quality issues

## Best Practices

1. **Regular Retraining**: Retrain models periodically with new data
2. **Monitor Performance**: Track decision accuracy over time
3. **Balance Automation**: Use ML as guide, not absolute rule
4. **Review Logs**: Check ML decisions regularly
5. **Adjust Thresholds**: Fine-tune based on your risk tolerance

## Safety Features

- **Fallback**: If ML fails, executes trade normally
- **Balance Protection**: Never exceeds 95% of balance
- **Minimum Size**: Enforces $1 minimum
- **Error Handling**: Graceful degradation on errors
- **Logging**: All decisions logged for review

## Next Steps

1. **Enable Algorithm**: Set `ML_ALGORITHM_ENABLED=true`
2. **Monitor Logs**: Watch ML decisions in action
3. **Review Performance**: Track accuracy over time
4. **Fine-tune**: Adjust thresholds based on results
5. **Retrain**: Update models with new data periodically

## Support

For issues or questions:
- Check logs for detailed error messages
- Review `MODEL_TRAINING_GUIDE.md` for model details
- Verify models are trained and up-to-date
- Test with sample data using CLI
