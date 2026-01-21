# Trading Pattern Model Training Guide

## Overview

The Advanced Trading Pattern Recognition Model learns trading patterns from historical trade data and can predict:
1. **Which outcome to buy** (Up/Down) based on market conditions
2. **Trade size** based on price, timing, and market context
3. **Trading patterns** through clustering and statistical analysis

## Features

### Advanced Feature Engineering
- **Time-series features**: Moving averages (MA5, MA10), volatility, momentum, price changes
- **Market context**: Price distance from 0.5, cheaper outcome detection, volume trends
- **Temporal features**: Hour, day of week, business hours, weekend detection
- **Sequential patterns**: Trade sequence numbers, outcome switches, time between trades
- **Market timing**: Hours until market resolution, market-specific hour extraction

### Machine Learning Models
- **Random Forest**: Robust ensemble method for both classification and regression
- **Gradient Boosting**: Advanced boosting algorithm for better accuracy
- **Model Selection**: Automatically selects the best performing model
- **Time-series Cross-Validation**: Uses temporal splits for realistic evaluation

### Pattern Discovery
- **Price-based patterns**: Analysis of buying behavior relative to price levels
- **Time-based patterns**: Most active trading hours and timing patterns
- **Size patterns**: Statistical analysis of trade sizes
- **Sequential patterns**: Outcome switching behavior and trade frequency
- **Clustering**: Identifies different trading styles/strategies

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Train the Model

```bash
# Using npm script
npm run train-pattern-model

# Or directly with Python
python3 src/scripts/tradingPatternModel.py
```

### 3. Use the Trained Model

The model will:
1. Load all JSON files from `historical_trades/` directory
2. Extract advanced features from trade data
3. Discover trading patterns
4. Train prediction models
5. Save models to `models/` directory
6. Test predictions on sample cases

## Output Files

After training, the following files will be created in `models/`:

- `outcome_model.pkl` - Model for predicting which outcome to buy
- `outcome_scaler.pkl` - Feature scaler for outcome prediction
- `outcome_label_encoder.pkl` - Label encoder for outcomes
- `size_model.pkl` - Model for predicting trade size
- `size_scaler.pkl` - Feature scaler for size prediction
- `feature_importance.json` - Feature importance rankings
- `discovered_patterns.json` - Discovered trading patterns and clusters

## Using the Model in Code

```python
from src.scripts.tradingPatternModel import TradingPatternModel
import joblib

# Load trained model
model = TradingPatternModel('historical_trades')
model.models['outcome'] = joblib.load('models/outcome_model.pkl')
model.scalers['outcome'] = joblib.load('models/outcome_scaler.pkl')
model.label_encoders['outcome'] = joblib.load('models/outcome_label_encoder.pkl')

# Predict which outcome to buy
prediction = model.predict_outcome(
    price=0.35,      # Current market price
    hour=14,          # Current hour (0-23)
    size=10,         # Trade size in tokens
    usdc_size=5      # Trade size in USDC
)

print(f"Predicted outcome: {prediction['predicted_outcome']}")
print(f"Confidence: {prediction['confidence']:.2%}")
print(f"Probabilities: {prediction['probabilities']}")

# Predict trade size
size_pred = model.predict_trade_size(
    price=0.35,
    hour=14,
    outcome_index=0  # 0 for Up, 1 for Down
)

print(f"Predicted size: ${size_pred['predicted_usdc_size']:.2f} USDC")
```

## Model Features Explained

### Price Features
- `price`: Current market price (0-1)
- `price_distance_from_50`: Distance from 0.5 (market equilibrium)
- `is_cheaper_outcome`: Whether buying the cheaper outcome
- `price_category`: low (<0.4), mid (0.4-0.6), high (>0.6)

### Time-Series Features
- `price_ma5`: 5-trade moving average of prices
- `price_ma10`: 10-trade moving average of prices
- `price_volatility`: Standard deviation of recent prices
- `price_range`: Range of recent prices
- `price_momentum`: Recent price change
- `price_change_pct`: Percentage change in price

### Market Context Features
- `volume_trend`: Trend in trade sizes
- `is_high_volume`: Whether current trade is high volume
- `outcome_switched`: Whether outcome changed from last trade
- `trade_sequence_num`: Position in trade sequence for this market
- `time_since_last_trade`: Seconds since last trade

### Temporal Features
- `hour`: Hour of day (0-23)
- `day_of_week`: Day of week (0=Monday, 6=Sunday)
- `is_weekend`: Whether it's weekend
- `is_business_hours`: Whether it's 9am-5pm
- `market_hour`: Market resolution hour extracted from slug
- `hours_until_market`: Hours until market resolution

## Pattern Discovery

The model automatically discovers patterns including:

1. **Price-Based Strategy**: Percentage of trades buying cheaper vs expensive outcomes
2. **Active Trading Hours**: Most common hours for trading
3. **Size Distribution**: Mean, median, min, max trade sizes
4. **Sequential Behavior**: How often outcomes switch, trades per market
5. **Trading Clusters**: Different trading styles identified through clustering

## Model Performance

The model reports:
- **Accuracy**: For outcome prediction (classification)
- **R² Score**: For size prediction (regression)
- **Feature Importance**: Which features matter most
- **Classification Report**: Detailed metrics per class

## Tips for Better Results

1. **More Data**: More historical trades = better patterns
2. **Data Quality**: Ensure timestamps are accurate
3. **Feature Engineering**: Model automatically creates advanced features
4. **Regular Retraining**: Retrain periodically as new data arrives
5. **Pattern Analysis**: Review discovered patterns to understand trading behavior

## Troubleshooting

### "No valid trades for training"
- Check that JSON files contain trades with `outcome` field set to "Up" or "Down"
- Ensure `price` values are between 0 and 1
- Verify `type` field is "TRADE" (not "MERGE")

### Low Accuracy
- Ensure sufficient training data (hundreds of trades minimum)
- Check for data quality issues
- Review feature importance to see which features matter

### Memory Issues
- Reduce number of files processed
- Process files in batches
- Increase system memory

## Advanced Usage

### Custom Feature Engineering

You can extend the model by modifying the `extract_features` method to add custom features:

```python
# Add custom feature
feature['custom_feature'] = your_calculation(trade)
```

### Custom Models

Add new models to the training pipeline:

```python
models_to_try = {
    'random_forest': RandomForestClassifier(...),
    'gradient_boosting': GradientBoostingClassifier(...),
    'your_model': YourCustomModel(...),  # Add here
}
```

### Pattern Analysis

Access discovered patterns:

```python
patterns = model.patterns
print(patterns['price_based'])
print(patterns['clusters'])
```

## Next Steps

1. Train the model on your historical data
2. Review discovered patterns
3. Integrate predictions into your trading bot
4. Monitor performance and retrain periodically
5. Experiment with feature engineering
