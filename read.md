# Complete Project Overview: Inverse Reinforcement Learning for Trader Algorithm

## 🎯 What This Project Does

This project **reverse-engineers a trader's algorithm** by learning from their historical trading data. Instead of manually coding trading rules, the model learns the trader's decision-making patterns and can replicate their behavior.

**Goal**: Create an AI bot that "twins" the actions of a successful trader by learning from their past trades.

---

## 📊 What You Feed the Model

### Input Data Structure

The model needs **trader's historical trading data** with the following:

#### 1. **Price Files** (from Cloudflare R2 bucket)
- Location: `downloads/merged_trades/{address}/btc-*_prices.json`
- Contains:
  - **Trade events**: Timestamp, price, side (BUY/SELL), size, USD value
  - **Market data**: OHLCV (Open, High, Low, Close, Volume) bars
  - **Price changes**: Bid/ask spreads, mid prices

#### 2. **Data Format Example**
```json
{
  "slug": "btc-updown-15m-1768904100",
  "prices": [
    {
      "t": 1768904486000,
      "type": "trade",
      "price": 0.77,
      "side": "BUY",
      "size": 20,
      "usdc": 15.4
    },
    ...
  ]
}
```

#### 3. **What the Model Sees**
For each trade, the model receives:
- **RTG (Return-to-Go)**: Expected future return from this point
- **State (s_t)**: 17 features including:
  - Market microstructure (FracDiff prices, volatility, volume)
  - Technical indicators (RSI, MACD, Bollinger Bands)
  - Temporal data (time-of-day, hour, day-of-week)
  - Agent state (inventory, P&L, position size)
- **Action (a_t)**: What the trader did (BUY/SELL/HOLD)

---

## 🔄 Complete Pipeline: Step-by-Step

### Step 1: Data Ingestion & Cleaning
**File**: `data_ingestion.py`

**What it does**:
1. Loads all BTC price files from `downloads/merged_trades/`
2. Parses trade events and market data
3. Creates OHLCV bars (15-minute intervals)
4. Tracks trader's position state (inventory, entry price, P&L)
5. **Critical**: Aligns features temporally - no future data leakage!

**Output**: DataFrame with trades and aligned market features

**Key Feature**: Each trade only sees data available **before** that trade happened.

---

### Step 2: Advanced Feature Engineering
**File**: `feature_engineering.py`

**What it does**:
1. **Yang-Zhang Volatility**: Better volatility estimator accounting for gaps
2. **Fractional Differentiation**: Makes prices stationary while preserving memory
3. **Technical Indicators**: RSI, MACD, Bollinger Bands, moving averages

**Why**: Raw prices are noisy and non-stationary. These features make patterns easier to learn.

---

### Step 3: Triple Barrier Method Labeling
**File**: `labeling.py`

**What it does**:
1. Creates three "barriers" for each trade:
   - **Upper barrier**: Profit-taking threshold (e.g., +2% return)
   - **Lower barrier**: Stop-loss threshold (e.g., -2% return)
   - **Horizontal barrier**: Time-out after X bars
2. Labels each trade: Which barrier was hit first?
3. Analyzes trader's actual exits to find optimal barrier thresholds

**Output**: Labels (upper/lower/timeout) and P&L for each trade

**Why**: Provides clear learning signals - did this trade lead to profit or loss?

---

### Step 4: State Feature Engineering φ(s_t)
**File**: `state_features.py`

**What it does**:
Creates comprehensive state representation with **17 features**:

**Market Microstructure** (3 features):
- FracDiff normalized prices
- Yang-Zhang volatility (normalized)
- Volume Z-scores

**Technical Context** (3 features):
- RSI (normalized)
- MACD Histogram (normalized)
- Bollinger Band width (normalized)

**Temporal Data** (6 features):
- Time-of-day (sine/cosine)
- Hour (sine/cosine)
- Day-of-week (sine/cosine)

**Agent State** (5 features):
- Unrealized P&L (normalized)
- P&L as % of position
- Inventory (normalized)
- Position size ratio
- Time since entry (normalized)

**Output**: Normalized state vector ready for model input

---

### Step 5: Action Discretization
**File**: `action_discretization.py`

**What it does**:
Converts continuous actions into **5 discrete categories**:
- **STRONG_BUY** (0): Large buy orders
- **BUY** (1): Regular buy orders
- **HOLD** (2): No action
- **SELL** (3): Regular sell orders
- **STRONG_SELL** (4): Large sell orders

**Why**: Discrete actions converge faster than continuous actions.

---

### Step 6: Sequence Preparation
**File**: `sequence_preparation.py`

**What it does**:
1. Creates sliding windows of **128 bars** (32 hours of 15-minute data)
2. For each window, prepares:
   - **RTG sequence**: Return-to-Go values (scaled by 100x)
   - **State sequence**: 17 features per timestep
   - **Action sequence**: One-hot encoded actions (5 categories)
   - **Returns**: Actual returns for RTG computation
3. Converts to PyTorch tensors
4. Creates DataLoader for training

**Output**: Batches of sequences ready for model training

---

## 🧠 Model Architecture

### Decision Transformer
**File**: `model_architecture.py`

**Architecture**:
```
Input: (RTG, States, Actions) triplets
    ↓
[RTG Encoder] → d_model (128)
[State Encoder] → d_model (128)
[Action Encoder] → d_model (128)
    ↓
Concatenate → 3×d_model
    ↓
Project → d_model
    ↓
[Positional Encoding]
    ↓
[Transformer Decoder × 6 layers]
  └─ Causal Masking (no future peeking!)
    ↓
[Action Head] → Predicted Actions (5 categories)
[RTG Head] → Predicted RTG
```

**Key Features**:
- **Context Window**: 128 bars (32 hours)
- **Causal Masking**: Can't see future data
- **RTG Scaling**: RTG scaled 100x for better attention
- **3 Separate Encoders**: RTG, State, Action encoded separately

---

## 🎓 How Training Works

### The RTG (Return-to-Go) Magic

**During Training**:
- Model sees **actual RTG**: RTG_t = Σ(actual returns from t to end)
- Learns: "When RTG was 0.05 (5%), trader did BUY"
- Learns: "When RTG was -0.02 (-2%), trader did SELL"

**During Inference**:
- You provide **target RTG**: "I want 2% return"
- Model predicts: "To get 2% return, I should BUY now"
- Uses learned associations from training

### Training Process
**File**: `training.py`

1. **Load Batch**: Get sequences of (RTG, States, Actions)
2. **Compute RTG**: RTG_t = sum of actual returns from t to end
3. **Scale RTG**: Multiply by 100 (0.02 → 2.0)
4. **Forward Pass**: Model predicts actions and RTG
5. **Compute Loss**:
   - Action loss: Cross-entropy (predicted vs actual actions)
   - RTG loss: MSE (predicted vs actual RTG)
6. **Backward Pass**: Update model parameters
7. **Repeat**: For all batches and epochs

### Loss Function
```
Total Loss = action_loss_weight × Action_Loss + rtg_loss_weight × RTG_Loss
           = 1.0 × CrossEntropy(pred_actions, true_actions) 
           + 0.1 × MSE(pred_rtg, true_rtg)
```

---

## 🔍 How It Finds Patterns

### Pattern Discovery Process

1. **Attention Mechanism**:
   - Model learns which past timesteps are important
   - Example: "When RSI was high AND volatility was low, trader bought"

2. **RTG Association**:
   - Learns: "High RTG sequences → BUY actions"
   - Learns: "Low RTG sequences → SELL actions"
   - Learns: "Medium RTG sequences → HOLD actions"

3. **State Patterns**:
   - Learns combinations of features that lead to actions
   - Example: "High inventory + negative P&L → SELL"
   - Example: "Low inventory + high volatility → BUY"

4. **Temporal Patterns**:
   - Learns time-of-day effects
   - Example: "Morning trades → different strategy than evening"

5. **Sequence Patterns**:
   - Learns action sequences
   - Example: "BUY → HOLD → BUY → SELL" pattern

### What Makes It Work

- **Causal Masking**: Only sees past data (no cheating!)
- **RTG Scaling**: Better attention to return differences
- **Discrete Actions**: Clearer patterns to learn
- **Rich State Features**: Captures all relevant information
- **Long Context**: 32 hours of history for decision-making

---

## 🧪 How to Test It

### Step 1: Prepare Data
```bash
# Data should already be in downloads/merged_trades/
# If not, download from Cloudflare R2 bucket first
python download_bucket.py
```

### Step 2: Run Full Pipeline
```bash
# This processes all data and creates training-ready dataset
python pipeline.py
```

**What happens**:
- Loads BTC price files
- Creates features
- Labels trades
- Discretizes actions
- Saves to `data/processed_trader_data.parquet`

### Step 3: Train Model
```bash
python train_model.py \
    --data_dir downloads/merged_trades \
    --output_dir models \
    --epochs 50 \
    --batch_size 32 \
    --device cuda  # or 'cpu'
```

**What happens**:
- Loads processed data
- Creates sequences
- Splits train/validation
- Trains model for 50 epochs
- Saves checkpoints to `models/`

### Step 4: Test Inference
```python
from training import TraderInference
from model_architecture import TraderDecisionTransformer
import torch

# Load trained model
model = TraderDecisionTransformer(state_dim=17, action_dim=5)
checkpoint = torch.load('models/best_model.pt')
model.load_state_dict(checkpoint['model_state_dict'])

# Create inference engine
inference = TraderInference(model, device='cpu')

# Prepare current state (example)
states = torch.randn(1, 128, 17)  # (batch, seq_len, state_dim)

# Predict actions for 2% target return
predicted_actions, predicted_rtg = inference.predict_with_target_rtg(
    states=states,
    target_rtg=0.02  # 2% target return
)

# Get action probabilities
action_probs = torch.softmax(predicted_actions[0, -1], dim=-1)
print(f"Action probabilities: {action_probs}")
print(f"Predicted action: {action_probs.argmax().item()}")
```

### Step 5: Evaluate Performance

**Metrics to Check**:
1. **Training Loss**: Should decrease over epochs
2. **Validation Loss**: Should track training loss (no overfitting)
3. **Action Accuracy**: % of correctly predicted actions
4. **RTG Prediction Error**: How close predicted RTG is to actual

**Example Evaluation**:
```python
from training import TraderTrainer

trainer = TraderTrainer(model, device='cpu')
val_metrics = trainer.validate(val_loader)

print(f"Validation Accuracy: {val_metrics['accuracy']:.2%}")
print(f"Validation Loss: {val_metrics['loss']:.4f}")
```

---

## 📋 Complete Workflow Summary

### Data Flow
```
Raw Price Files (JSON)
    ↓
[Data Ingestion] → Trades + Market Data
    ↓
[Feature Engineering] → Advanced Features
    ↓
[Labeling] → TBM Labels + P&L
    ↓
[State Features] → φ(s_t) - 17 features
    ↓
[Action Discretization] → 5 action categories
    ↓
[Sequence Preparation] → (RTG, State, Action) sequences
    ↓
[Model Training] → Trained Decision Transformer
    ↓
[Inference] → Action predictions for target RTG
```

### Training Flow
```
1. Load sequences (128 bars each)
2. Compute RTG from actual returns
3. Scale RTG (×100)
4. Forward pass through model
5. Predict actions and RTG
6. Compute loss (action + RTG)
7. Backward pass (update weights)
8. Repeat for all batches
9. Validate on held-out data
10. Save best model
```

### Inference Flow
```
1. Provide target RTG (e.g., 2%)
2. Scale target RTG (×100)
3. Create RTG sequence with target
4. Forward pass through model
5. Model predicts actions to achieve target
6. Return predicted actions
```

---

## 🎯 Key Concepts Explained

### 1. Why RTG?
- **Training**: Shows model what outcomes actions lead to
- **Inference**: Lets you specify desired returns
- **Magic**: Model learns associations, not just patterns

### 2. Why Causal Masking?
- Prevents data leakage
- Ensures model only uses past information
- Critical for real-world deployment

### 3. Why Action Discretization?
- Faster convergence
- Clearer patterns
- Easier to interpret

### 4. Why RTG Scaling?
- Market returns are tiny (0.001-0.05)
- Attention mechanism needs larger differences
- Scaling makes patterns more visible

### 5. Why 128 Bars?
- 32 hours of market history
- Captures daily patterns
- Enough context for decision-making

---

## 🚀 Quick Start Guide

### 1. Setup
```bash
# Install dependencies
pip install -r requirements.txt

# Ensure .env file has Cloudflare credentials
# (if downloading from R2)
```

### 2. Process Data
```bash
python pipeline.py
```

### 3. Train Model
```bash
python train_model.py --epochs 50 --device cuda
```

### 4. Test Inference
```python
# See Step 4 above for inference code
```

---

## 📊 Expected Results

### Training Metrics
- **Action Accuracy**: 40-60% (better than random 20%)
- **Training Loss**: Decreases from ~2.0 to ~0.5
- **Validation Loss**: Tracks training loss closely

### Model Behavior
- Learns to predict actions based on RTG
- Associates high RTG with BUY actions
- Associates low RTG with SELL actions
- Captures temporal patterns (time-of-day effects)

### Inference Results
- Given target RTG, predicts appropriate actions
- Actions align with trader's historical behavior
- Can achieve target returns by following predictions

---

## 🔧 Troubleshooting

### Common Issues

1. **No data loaded**
   - Check: `downloads/merged_trades/` has BTC price files
   - Fix: Run `download_bucket.py` first

2. **Out of memory**
   - Reduce: `batch_size` or `context_window`
   - Use: `device='cpu'` instead of `cuda`

3. **Poor accuracy**
   - Check: Enough training data (need 1000+ sequences)
   - Try: More epochs, different learning rate
   - Verify: Features are normalized correctly

4. **Model not converging**
   - Check: RTG scaling is applied
   - Verify: Causal masking is working
   - Try: Lower learning rate

---

## 📚 File Structure

```
Inverse-Reinforcement-Learning/
├── data_ingestion.py          # Step 1: Load and clean data
├── feature_engineering.py     # Step 2: Advanced features
├── labeling.py                # Step 3: Triple Barrier Method
├── state_features.py          # Step 4: State representation
├── action_discretization.py   # Step 5: Action categories
├── sequence_preparation.py    # Step 6: Create sequences
├── model_architecture.py      # Model definition
├── training.py                 # Training logic
├── pipeline.py                 # Complete pipeline
├── train_model.py             # Training script
├── download_bucket.py          # Download from R2
└── data/                       # Processed data
    └── processed_trader_data.parquet
```

---

## 🎓 Summary

**What you feed**: Trader's historical trading data (price files)

**How it trains**: 
- Learns from (RTG, State, Action) triplets
- RTG shows actual outcomes
- Model learns associations

**How it finds patterns**:
- Attention mechanism finds important timesteps
- RTG associations link outcomes to actions
- State patterns capture market conditions
- Temporal patterns capture time effects

**How to test**:
1. Run `pipeline.py` to process data
2. Run `train_model.py` to train
3. Use inference code to predict actions
4. Evaluate on validation set

**The magic**: Model learns trader's implicit strategy by seeing what actions led to what outcomes, then can replicate that strategy for target returns!
