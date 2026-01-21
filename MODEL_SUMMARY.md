# Trading Pattern Model - Summary

## What Was Created

An advanced machine learning model that can learn trading patterns from your historical trade data and make predictions.

## Key Capabilities

### 1. **Pattern Recognition**
- Discovers price-based trading strategies (buying cheaper outcomes)
- Identifies time-based patterns (most active trading hours)
- Analyzes size patterns (typical trade sizes)
- Detects sequential patterns (outcome switching behavior)

### 2. **Predictions**
- **Outcome Prediction**: Predicts whether to buy "Up" or "Down" based on:
  - Current market price
  - Time-series features (moving averages, volatility, momentum)
  - Market context (volume trends, trade sequence)
  - Temporal features (hour, day, business hours)

- **Trade Size Prediction**: Predicts optimal trade size based on:
  - Market conditions
  - Price levels
  - Historical patterns
  - Market timing

### 3. **Advanced Features**

The model extracts 25+ features including:

**Price Features:**
- Current price, distance from 0.5, price category
- Moving averages (5-trade, 10-trade)
- Volatility and price range
- Momentum and percentage changes

**Time-Series Features:**
- Price trends and changes
- Volume trends
- Trade sequence position
- Time between trades

**Temporal Features:**
- Hour, day of week, weekend detection
- Business hours detection
- Market resolution timing

**Market Context:**
- Outcome switching patterns
- High volume detection
- Market-specific features

## Files Created/Modified

1. **`src/scripts/tradingPatternModel.py`** - Enhanced ML model with:
   - Advanced feature engineering
   - Multiple ML algorithms (Random Forest, Gradient Boosting)
   - Pattern discovery (clustering, statistical analysis)
   - Time-series cross-validation
   - Model persistence

2. **`MODEL_TRAINING_GUIDE.md`** - Complete documentation:
   - Quick start guide
   - Feature explanations
   - Usage examples
   - Troubleshooting tips

3. **`MODEL_SUMMARY.md`** - This file (overview)

## How to Use

### Quick Start

```bash
# Train the model
npm run train-pattern-model

# Or directly
python3 src/scripts/tradingPatternModel.py
```

### In Your Code

```python
from src.scripts.tradingPatternModel import TradingPatternModel
import joblib

# Load trained model
model = TradingPatternModel('historical_trades')
model.models['outcome'] = joblib.load('models/outcome_model.pkl')
model.scalers['outcome'] = joblib.load('models/outcome_scaler.pkl')
model.label_encoders['outcome'] = joblib.load('models/outcome_label_encoder.pkl')

# Make predictions
prediction = model.predict_outcome(price=0.35, hour=14, size=10, usdc_size=5)
print(f"Buy: {prediction['predicted_outcome']}")
print(f"Confidence: {prediction['confidence']:.2%}")
```

## Model Outputs

After training, you'll get:

1. **Trained Models** (`models/` directory):
   - `outcome_model.pkl` - Predicts Up/Down
   - `size_model.pkl` - Predicts trade size
   - Scalers and encoders for preprocessing

2. **Pattern Analysis**:
   - Price-based strategy percentages
   - Most active trading hours
   - Size distribution statistics
   - Sequential behavior patterns
   - Trading style clusters

3. **Feature Importance**:
   - Which features matter most for predictions
   - Helps understand trading behavior

## What Makes This Model Advanced

1. **Time-Series Awareness**: Uses market history to create context-aware features
2. **Multiple Algorithms**: Tries different models and picks the best
3. **Pattern Discovery**: Automatically finds trading patterns through clustering
4. **Robust Evaluation**: Uses time-series cross-validation (no data leakage)
5. **Rich Features**: 25+ engineered features from raw trade data

## Next Steps

1. **Train the model** on your historical data
2. **Review discovered patterns** to understand trading behavior
3. **Integrate predictions** into your trading bot
4. **Monitor performance** and retrain with new data
5. **Experiment** with feature engineering for better results

## Data Requirements

The model expects JSON files in `historical_trades/` with trade objects containing:
- `price`: Market price (0-1)
- `size`: Trade size in tokens
- `usdcSize`: Trade size in USDC
- `timestamp`: Unix timestamp
- `outcome`: "Up" or "Down"
- `side`: "BUY" or "SELL"
- `type`: "TRADE" (MERGE events are skipped)

## Performance

The model will report:
- **Accuracy** for outcome prediction
- **R² Score** for size prediction
- **Feature importance** rankings
- **Pattern statistics**

Typical performance depends on:
- Amount of training data
- Data quality
- Consistency of trading patterns

## Support

See `MODEL_TRAINING_GUIDE.md` for:
- Detailed feature explanations
- Advanced usage examples
- Troubleshooting guide
- Customization options
