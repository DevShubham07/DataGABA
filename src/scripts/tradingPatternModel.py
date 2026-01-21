#!/usr/bin/env python3
"""
Advanced Trading Pattern Recognition Model
Trains ML models to identify and predict trading patterns from historical data
Includes sequential pattern recognition, time-series features, and pattern discovery
"""

import json
import os
import glob
import numpy as np
import pandas as pd
from datetime import datetime
from collections import defaultdict, Counter, deque
from sklearn.model_selection import train_test_split, TimeSeriesSplit
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor, GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.preprocessing import StandardScaler, LabelEncoder, MinMaxScaler
from sklearn.cluster import KMeans, DBSCAN
from sklearn.metrics import accuracy_score, classification_report, mean_squared_error, r2_score, silhouette_score
from sklearn.decomposition import PCA
import joblib
import warnings
warnings.filterwarnings('ignore')

class TradingPatternModel:
    def __init__(self, data_dir='historical_trades'):
        self.data_dir = data_dir
        self.models = {}
        self.scalers = {}
        self.label_encoders = {}
        self.feature_importance = {}
        self.patterns = {}
        self.clusters = None
        
    def load_all_trades(self):
        """Load all trade data from JSON files"""
        print("📂 Loading trade data...")
        all_trades = []
        files = sorted(glob.glob(os.path.join(self.data_dir, '*.json')))
        
        for file_path in files:
            try:
                with open(file_path, 'r') as f:
                    trades = json.load(f)
                    if isinstance(trades, list):
                        # Add market slug from filename
                        slug = os.path.basename(file_path).replace('.json', '')
                        for trade in trades:
                            trade['market_slug'] = slug
                            trade['file_path'] = file_path
                        all_trades.extend(trades)
            except Exception as e:
                print(f"   ⚠️  Error loading {file_path}: {e}")
        
        print(f"✅ Loaded {len(all_trades)} total trades from {len(files)} files")
        return all_trades
    
    def extract_features(self, trades):
        """Extract advanced features from trade data with time-series context"""
        print("\n🔍 Extracting advanced features...")
        
        # Sort trades by timestamp for time-series features
        trades_sorted = sorted(trades, key=lambda x: (x.get('market_slug', ''), x.get('timestamp', 0)))
        
        # Group by market slug for market-specific features
        trades_by_market = defaultdict(list)
        for trade in trades_sorted:
            slug = trade.get('market_slug', '')
            trades_by_market[slug].append(trade)
        
        features = []
        market_history = defaultdict(lambda: {
            'prices': deque(maxlen=50),
            'sizes': deque(maxlen=50),
            'outcomes': deque(maxlen=50),
            'timestamps': deque(maxlen=50),
            'last_price': None,
            'price_changes': deque(maxlen=20),
        })
        
        for trade in trades_sorted:
            slug = trade.get('market_slug', '')
            hist = market_history[slug]
            
            # Skip MERGE events for feature extraction (but keep for analysis)
            if trade.get('type') == 'MERGE':
                continue
            
            # Basic features
            feature = {
                'price': trade.get('price', 0),
                'size': trade.get('size', 0),
                'usdcSize': trade.get('usdcSize', 0),
                'timestamp': trade.get('timestamp', 0),
                'outcome': trade.get('outcome', ''),
                'side': trade.get('side', ''),
                'outcomeIndex': trade.get('outcomeIndex', -1),
                'market_slug': slug,
                'type': trade.get('type', 'TRADE'),
            }
            
            # Temporal features
            if feature['timestamp']:
                dt = datetime.fromtimestamp(feature['timestamp'])
                feature['hour'] = dt.hour
                feature['day_of_week'] = dt.weekday()
                feature['day_of_month'] = dt.day
                feature['minute'] = dt.minute
                feature['is_weekend'] = 1 if dt.weekday() >= 5 else 0
                feature['is_business_hours'] = 1 if 9 <= dt.hour <= 17 else 0
            
            # Price-based features
            price = feature['price']
            feature['price_distance_from_50'] = abs(price - 0.5)
            feature['is_cheaper_outcome'] = 1 if (feature['outcome'] == 'Up' and price < 0.5) or \
                                                 (feature['outcome'] == 'Down' and price > 0.5) else 0
            feature['price_category'] = 'low' if price < 0.4 else ('high' if price > 0.6 else 'mid')
            
            # Time-series features from market history
            if len(hist['prices']) > 0:
                recent_prices = list(hist['prices'])
                recent_sizes = list(hist['sizes'])
                
                # Moving averages
                feature['price_ma5'] = np.mean(recent_prices[-5:]) if len(recent_prices) >= 5 else price
                feature['price_ma10'] = np.mean(recent_prices[-10:]) if len(recent_prices) >= 10 else price
                feature['size_ma5'] = np.mean(recent_sizes[-5:]) if len(recent_sizes) >= 5 else feature['size']
                
                # Volatility
                if len(recent_prices) >= 5:
                    feature['price_volatility'] = np.std(recent_prices[-5:])
                    feature['price_range'] = max(recent_prices[-5:]) - min(recent_prices[-5:])
                else:
                    feature['price_volatility'] = 0
                    feature['price_range'] = 0
                
                # Price momentum
                if len(recent_prices) >= 3:
                    feature['price_momentum'] = recent_prices[-1] - recent_prices[-3]
                    feature['price_change_pct'] = (recent_prices[-1] - recent_prices[-3]) / recent_prices[-3] if recent_prices[-3] > 0 else 0
                else:
                    feature['price_momentum'] = 0
                    feature['price_change_pct'] = 0
                
                # Last price comparison
                if hist['last_price'] is not None:
                    feature['price_diff_from_last'] = price - hist['last_price']
                    feature['price_change_direction'] = 1 if price > hist['last_price'] else (-1 if price < hist['last_price'] else 0)
                else:
                    feature['price_diff_from_last'] = 0
                    feature['price_change_direction'] = 0
                
                # Volume features
                feature['volume_trend'] = np.mean(recent_sizes[-3:]) - np.mean(recent_sizes[-6:-3]) if len(recent_sizes) >= 6 else 0
                feature['is_high_volume'] = 1 if feature['size'] > np.percentile(recent_sizes, 75) else 0 if len(recent_sizes) > 0 else 0
            else:
                # Default values for first trade in market
                feature['price_ma5'] = price
                feature['price_ma10'] = price
                feature['size_ma5'] = feature['size']
                feature['price_volatility'] = 0
                feature['price_range'] = 0
                feature['price_momentum'] = 0
                feature['price_change_pct'] = 0
                feature['price_diff_from_last'] = 0
                feature['price_change_direction'] = 0
                feature['volume_trend'] = 0
                feature['is_high_volume'] = 0
            
            # Sequential pattern features
            if len(hist['outcomes']) >= 2:
                last_outcomes = list(hist['outcomes'])[-2:]
                feature['last_outcome'] = last_outcomes[-1] if last_outcomes else ''
                feature['outcome_switched'] = 1 if len(last_outcomes) >= 2 and last_outcomes[-1] != last_outcomes[-2] else 0
            else:
                feature['last_outcome'] = ''
                feature['outcome_switched'] = 0
            
            # Market context features
            feature['trade_sequence_num'] = len(hist['prices'])
            feature['time_since_first_trade'] = feature['timestamp'] - hist['timestamps'][0] if len(hist['timestamps']) > 0 else 0
            feature['time_since_last_trade'] = feature['timestamp'] - hist['timestamps'][-1] if len(hist['timestamps']) > 0 else 0
            
            # Extract market hour from slug
            slug_lower = slug.lower()
            if 'am' in slug_lower or 'pm' in slug_lower:
                # Try to extract hour from slug like "january-21-2am-et"
                parts = slug_lower.split('-')
                for part in parts:
                    if 'am' in part or 'pm' in part:
                        try:
                            hour_str = part.replace('am', '').replace('pm', '').replace('et', '')
                            market_hour = int(hour_str)
                            if 'pm' in part and market_hour < 12:
                                market_hour += 12
                            feature['market_hour'] = market_hour
                            break
                        except:
                            feature['market_hour'] = 12  # default
                else:
                    feature['market_hour'] = 12
            else:
                feature['market_hour'] = 12
            
            # Time until market resolution (if we can infer from slug)
            feature['hours_until_market'] = abs(feature['hour'] - feature['market_hour'])
            
            features.append(feature)
            
            # Update history
            hist['prices'].append(price)
            hist['sizes'].append(feature['size'])
            hist['outcomes'].append(feature['outcome'])
            hist['timestamps'].append(feature['timestamp'])
            hist['last_price'] = price
            if len(hist['prices']) >= 2:
                hist['price_changes'].append(hist['prices'][-1] - hist['prices'][-2])
        
        df = pd.DataFrame(features)
        print(f"✅ Extracted {len(df)} samples with {len(df.columns)} features")
        return df
    
    def discover_patterns(self, df):
        """Discover trading patterns using clustering and statistical analysis"""
        print("\n🔎 Discovering Trading Patterns...")
        
        # Filter valid trades
        valid_df = df[(df['outcome'].isin(['Up', 'Down'])) & (df['price'] > 0) & (df['price'] < 1)].copy()
        
        if len(valid_df) == 0:
            print("   ⚠️  No valid trades for pattern discovery")
            return
        
        # Pattern 1: Price-based decision making
        up_trades = valid_df[valid_df['outcome'] == 'Up']
        down_trades = valid_df[valid_df['outcome'] == 'Down']
        
        patterns = {
            'price_based': {
                'buy_up_below_50': len(up_trades[up_trades['price'] < 0.5]),
                'buy_up_above_50': len(up_trades[up_trades['price'] > 0.5]),
                'buy_down_below_50': len(down_trades[down_trades['price'] < 0.5]),
                'buy_down_above_50': len(down_trades[down_trades['price'] > 0.5]),
            },
            'time_based': {},
            'size_based': {},
            'sequential': {},
        }
        
        # Pattern 2: Time-based patterns
        hour_dist = valid_df.groupby('hour').size().sort_values(ascending=False)
        patterns['time_based']['most_active_hours'] = hour_dist.head(10).to_dict()
        
        # Pattern 3: Size patterns
        patterns['size_based'] = {
            'mean_size': float(valid_df['usdcSize'].mean()),
            'median_size': float(valid_df['usdcSize'].median()),
            'std_size': float(valid_df['usdcSize'].std()),
            'min_size': float(valid_df['usdcSize'].min()),
            'max_size': float(valid_df['usdcSize'].max()),
        }
        
        # Pattern 4: Sequential patterns
        valid_df_sorted = valid_df.sort_values('timestamp')
        outcome_switches = (valid_df_sorted['outcome'] != valid_df_sorted['outcome'].shift()).sum()
        patterns['sequential']['outcome_switches'] = int(outcome_switches)
        patterns['sequential']['avg_trades_per_market'] = len(valid_df) / valid_df['market_slug'].nunique()
        
        # Pattern 5: Clustering to find trading styles
        feature_cols = ['price', 'usdcSize', 'hour', 'price_distance_from_50', 
                       'price_volatility', 'price_momentum', 'volume_trend']
        cluster_features = valid_df[feature_cols].fillna(0)
        
        if len(cluster_features) > 10:
            scaler = StandardScaler()
            cluster_features_scaled = scaler.fit_transform(cluster_features)
            
            # Use KMeans to find trading clusters
            n_clusters = min(5, len(cluster_features) // 10)
            if n_clusters >= 2:
                kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
                clusters = kmeans.fit_predict(cluster_features_scaled)
                valid_df['cluster'] = clusters
                
                patterns['clusters'] = {}
                for cluster_id in range(n_clusters):
                    cluster_data = valid_df[valid_df['cluster'] == cluster_id]
                    patterns['clusters'][f'cluster_{cluster_id}'] = {
                        'count': int(len(cluster_data)),
                        'avg_price': float(cluster_data['price'].mean()),
                        'avg_size': float(cluster_data['usdcSize'].mean()),
                        'preferred_outcome': cluster_data['outcome'].mode().iloc[0] if len(cluster_data['outcome'].mode()) > 0 else 'Unknown',
                        'avg_hour': float(cluster_data['hour'].mean()),
                    }
        
        self.patterns = patterns
        
        print(f"✅ Discovered {len(patterns)} pattern categories")
        return patterns
    
    def train_outcome_prediction_model(self, df):
        """Train advanced model to predict which outcome (Up/Down) to buy"""
        print("\n🎯 Training Outcome Prediction Model...")
        
        # Filter valid data
        valid_df = df[(df['outcome'].isin(['Up', 'Down'])) & (df['price'] > 0) & (df['price'] < 1)].copy()
        
        if len(valid_df) == 0:
            print("   ⚠️  No valid data for training")
            return None, 0
        
        # Advanced features for prediction
        feature_cols = [
            'price', 'price_distance_from_50', 'hour', 'day_of_week',
            'size', 'usdcSize', 'is_cheaper_outcome',
            'price_ma5', 'price_ma10', 'price_volatility', 'price_range',
            'price_momentum', 'price_change_pct', 'price_diff_from_last',
            'price_change_direction', 'volume_trend', 'is_high_volume',
            'outcome_switched', 'trade_sequence_num', 'time_since_last_trade',
            'market_hour', 'hours_until_market', 'is_weekend', 'is_business_hours'
        ]
        
        # Filter to columns that exist
        feature_cols = [col for col in feature_cols if col in valid_df.columns]
        
        X = valid_df[feature_cols].fillna(0)
        y = valid_df['outcome']
        
        # Encode labels
        le = LabelEncoder()
        y_encoded = le.fit_transform(y)
        self.label_encoders['outcome'] = le
        
        # Use time-series split for more realistic evaluation
        tscv = TimeSeriesSplit(n_splits=3)
        splits = list(tscv.split(X))
        train_idx, test_idx = splits[-1]  # Use last split
        
        X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
        y_train, y_test = y_encoded[train_idx], y_encoded[test_idx]
        
        # Scale features
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)
        self.scalers['outcome'] = scaler
        
        # Train multiple models and pick the best
        models_to_try = {
            'random_forest': RandomForestClassifier(n_estimators=200, max_depth=15, 
                                                     min_samples_split=5, random_state=42, n_jobs=-1),
            'gradient_boosting': GradientBoostingClassifier(n_estimators=200, max_depth=5, 
                                                             learning_rate=0.1, random_state=42),
        }
        
        best_model = None
        best_score = 0
        best_name = None
        
        for name, model in models_to_try.items():
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)
            score = accuracy_score(y_test, y_pred)
            
            if score > best_score:
                best_score = score
                best_model = model
                best_name = name
        
        self.models['outcome'] = best_model
        
        # Evaluate
        y_pred = best_model.predict(X_test_scaled)
        accuracy = accuracy_score(y_test, y_pred)
        
        print(f"✅ Model trained ({best_name})!")
        print(f"   Accuracy: {accuracy:.4f}")
        print(f"\n📊 Classification Report:")
        print(classification_report(y_test, y_pred, target_names=le.classes_))
        
        # Feature importance
        if hasattr(best_model, 'feature_importances_'):
            importance = pd.DataFrame({
                'feature': feature_cols,
                'importance': best_model.feature_importances_
            }).sort_values('importance', ascending=False)
            
            print(f"\n🔑 Top Features:")
            for _, row in importance.head(15).iterrows():
                print(f"   {row['feature']:30s}: {row['importance']:.4f}")
            
            self.feature_importance['outcome'] = importance
        
        return best_model, accuracy
    
    def train_trade_size_model(self, df):
        """Train advanced model to predict trade size"""
        print("\n💰 Training Trade Size Prediction Model...")
        
        # Filter valid data
        valid_df = df[(df['size'] > 0) & (df['usdcSize'] > 0) & 
                      (df['outcome'].isin(['Up', 'Down']))].copy()
        
        if len(valid_df) == 0:
            print("   ⚠️  No valid data for training")
            return None, 0
        
        # Features
        feature_cols = [
            'price', 'price_distance_from_50', 'hour', 'day_of_week',
            'outcomeIndex', 'is_cheaper_outcome',
            'price_ma5', 'price_volatility', 'price_momentum',
            'volume_trend', 'trade_sequence_num', 'time_since_last_trade',
            'market_hour', 'is_weekend', 'is_business_hours'
        ]
        
        # Filter to columns that exist
        feature_cols = [col for col in feature_cols if col in valid_df.columns]
        
        X = valid_df[feature_cols].fillna(0)
        y = valid_df['usdcSize']
        
        # Use time-series split
        tscv = TimeSeriesSplit(n_splits=3)
        splits = list(tscv.split(X))
        train_idx, test_idx = splits[-1]
        
        X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
        y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]
        
        # Scale features
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        X_test_scaled = scaler.transform(X_test)
        self.scalers['size'] = scaler
        
        # Train multiple models
        models_to_try = {
            'random_forest': RandomForestRegressor(n_estimators=200, max_depth=15,
                                                   min_samples_split=5, random_state=42, n_jobs=-1),
            'gradient_boosting': GradientBoostingRegressor(n_estimators=200, max_depth=5,
                                                           learning_rate=0.1, random_state=42),
        }
        
        best_model = None
        best_score = float('-inf')
        best_name = None
        
        for name, model in models_to_try.items():
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)
            score = r2_score(y_test, y_pred)
            
            if score > best_score:
                best_score = score
                best_model = model
                best_name = name
        
        self.models['size'] = best_model
        
        # Evaluate
        y_pred = best_model.predict(X_test_scaled)
        mse = mean_squared_error(y_test, y_pred)
        r2 = r2_score(y_test, y_pred)
        
        print(f"✅ Model trained ({best_name})!")
        print(f"   MSE: {mse:.4f}")
        print(f"   R² Score: {r2:.4f}")
        print(f"   Mean actual size: ${y_test.mean():.2f}")
        print(f"   Mean predicted size: ${y_pred.mean():.2f}")
        
        # Feature importance
        if hasattr(best_model, 'feature_importances_'):
            importance = pd.DataFrame({
                'feature': feature_cols,
                'importance': best_model.feature_importances_
            }).sort_values('importance', ascending=False)
            
            print(f"\n🔑 Top Features:")
            for _, row in importance.head(10).iterrows():
                print(f"   {row['feature']:30s}: {row['importance']:.4f}")
            
            self.feature_importance['size'] = importance
        
        return best_model, r2
    
    def analyze_patterns(self, df):
        """Analyze trading patterns and print detailed report"""
        print("\n📊 PATTERN ANALYSIS")
        print("=" * 70)
        
        # Filter valid trades
        valid_df = df[(df['outcome'].isin(['Up', 'Down'])) & (df['price'] > 0) & (df['price'] < 1)].copy()
        
        if len(valid_df) == 0:
            print("   ⚠️  No valid trades for analysis")
            return
        
        up_trades = valid_df[valid_df['outcome'] == 'Up']
        down_trades = valid_df[valid_df['outcome'] == 'Down']
        
        # Pattern 1: Price-based decision making
        up_below_50 = len(up_trades[up_trades['price'] < 0.5])
        up_above_50 = len(up_trades[up_trades['price'] > 0.5])
        down_below_50 = len(down_trades[down_trades['price'] < 0.5])
        down_above_50 = len(down_trades[down_trades['price'] > 0.5])
        
        print(f"\n🎯 Price-Based Decision Pattern:")
        print(f"   Buy Up when price < 0.5: {up_below_50} trades ({up_below_50/len(up_trades)*100:.1f}%)" if len(up_trades) > 0 else "   No Up trades")
        print(f"   Buy Up when price > 0.5: {up_above_50} trades ({up_above_50/len(up_trades)*100:.1f}%)" if len(up_trades) > 0 else "   No Up trades")
        print(f"   Buy Down when price < 0.5: {down_below_50} trades ({down_below_50/len(down_trades)*100:.1f}%)" if len(down_trades) > 0 else "   No Down trades")
        print(f"   Buy Down when price > 0.5: {down_above_50} trades ({down_above_50/len(down_trades)*100:.1f}%)" if len(down_trades) > 0 else "   No Down trades")
        
        cheaper_trades = up_below_50 + down_above_50
        total_trades = len(valid_df)
        print(f"\n   Strategy: Buy cheaper outcome {cheaper_trades}/{total_trades} times ({cheaper_trades/total_trades*100:.1f}%)")
        
        # Pattern 2: Time-based patterns
        print(f"\n⏰ Time-Based Patterns:")
        hour_dist = valid_df.groupby('hour').size().sort_values(ascending=False)
        print(f"   Most active hours:")
        for hour, count in hour_dist.head(5).items():
            print(f"      {hour:02d}:00 - {count} trades")
        
        # Pattern 3: Size patterns
        print(f"\n💰 Size Patterns:")
        print(f"   Average trade size: ${valid_df['usdcSize'].mean():.2f}")
        print(f"   Median trade size: ${valid_df['usdcSize'].median():.2f}")
        print(f"   Size std dev: ${valid_df['usdcSize'].std():.2f}")
        print(f"   Min size: ${valid_df['usdcSize'].min():.2f}")
        print(f"   Max size: ${valid_df['usdcSize'].max():.2f}")
        
        # Pattern 4: Price patterns
        print(f"\n💵 Price Patterns:")
        print(f"   Average price: ${valid_df['price'].mean():.4f}")
        print(f"   Price when buying Up: ${up_trades['price'].mean():.4f}" if len(up_trades) > 0 else "   No Up trades")
        print(f"   Price when buying Down: ${down_trades['price'].mean():.4f}" if len(down_trades) > 0 else "   No Down trades")
        print(f"   Price volatility: ${valid_df['price'].std():.4f}")
        
        # Pattern 5: Sequential patterns
        print(f"\n🔄 Sequential Patterns:")
        valid_df_sorted = valid_df.sort_values('timestamp')
        outcome_switches = (valid_df_sorted['outcome'] != valid_df_sorted['outcome'].shift()).sum()
        print(f"   Outcome switches: {outcome_switches}")
        print(f"   Markets traded: {valid_df['market_slug'].nunique()}")
        print(f"   Avg trades per market: {len(valid_df) / valid_df['market_slug'].nunique():.1f}")
        
        # Pattern 6: Market timing
        if 'time_since_last_trade' in valid_df.columns:
            print(f"\n⏱️  Market Timing:")
            print(f"   Avg time between trades: {valid_df['time_since_last_trade'].mean():.1f} seconds")
            print(f"   Median time between trades: {valid_df['time_since_last_trade'].median():.1f} seconds")
    
    def save_models(self, output_dir='models'):
        """Save trained models and patterns"""
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
        
        for name, model in self.models.items():
            model_path = os.path.join(output_dir, f'{name}_model.pkl')
            joblib.dump(model, model_path)
            print(f"💾 Saved {name} model to {model_path}")
        
        for name, scaler in self.scalers.items():
            scaler_path = os.path.join(output_dir, f'{name}_scaler.pkl')
            joblib.dump(scaler, scaler_path)
            print(f"💾 Saved {name} scaler to {scaler_path}")
        
        # Save label encoders
        for name, le in self.label_encoders.items():
            le_path = os.path.join(output_dir, f'{name}_label_encoder.pkl')
            joblib.dump(le, le_path)
            print(f"💾 Saved {name} label encoder to {le_path}")
        
        # Save feature importance
        if self.feature_importance:
            importance_path = os.path.join(output_dir, 'feature_importance.json')
            importance_dict = {}
            for name, imp_df in self.feature_importance.items():
                importance_dict[name] = imp_df.to_dict('records')
            
            with open(importance_path, 'w') as f:
                json.dump(importance_dict, f, indent=2)
            print(f"💾 Saved feature importance to {importance_path}")
        
        # Save discovered patterns
        if self.patterns:
            patterns_path = os.path.join(output_dir, 'discovered_patterns.json')
            with open(patterns_path, 'w') as f:
                json.dump(self.patterns, f, indent=2, default=str)
            print(f"💾 Saved discovered patterns to {patterns_path}")
    
    def predict_outcome(self, price, hour=12, size=10, usdc_size=5, **kwargs):
        """Predict which outcome to buy with advanced features"""
        if 'outcome' not in self.models:
            return None
        
        # Build feature vector with defaults
        defaults = {
            'price_distance_from_50': abs(price - 0.5),
            'day_of_week': 0,
            'is_cheaper_outcome': 1 if price < 0.5 else 0,
            'price_ma5': price,
            'price_ma10': price,
            'price_volatility': 0,
            'price_range': 0,
            'price_momentum': 0,
            'price_change_pct': 0,
            'price_diff_from_last': 0,
            'price_change_direction': 0,
            'volume_trend': 0,
            'is_high_volume': 0,
            'outcome_switched': 0,
            'trade_sequence_num': 1,
            'time_since_last_trade': 0,
            'market_hour': hour,
            'hours_until_market': 0,
            'is_weekend': 0,
            'is_business_hours': 1 if 9 <= hour <= 17 else 0,
        }
        defaults.update(kwargs)
        
        # Get feature columns from scaler
        feature_cols = self.scalers['outcome'].feature_names_in_ if hasattr(self.scalers['outcome'], 'feature_names_in_') else None
        
        if feature_cols is None:
            # Fallback: use common features
            features = np.array([[
                price, abs(price - 0.5), hour, defaults['day_of_week'],
                size, usdc_size, defaults['is_cheaper_outcome']
            ]])
        else:
            # Build feature vector matching training features
            feature_values = []
            for col in feature_cols:
                feature_values.append(defaults.get(col, 0))
            features = np.array([feature_values])
        
        features_scaled = self.scalers['outcome'].transform(features)
        prediction = self.models['outcome'].predict(features_scaled)[0]
        outcome = self.label_encoders['outcome'].inverse_transform([prediction])[0]
        
        probabilities = self.models['outcome'].predict_proba(features_scaled)[0]
        prob_dict = dict(zip(self.label_encoders['outcome'].classes_, probabilities))
        
        return {
            'predicted_outcome': outcome,
            'probabilities': prob_dict,
            'confidence': max(probabilities)
        }
    
    def predict_trade_size(self, price, hour=12, outcome_index=0, **kwargs):
        """Predict trade size with advanced features"""
        if 'size' not in self.models:
            return None
        
        is_cheaper = 1 if ((outcome_index == 0 and price < 0.5) or (outcome_index == 1 and price > 0.5)) else 0
        
        defaults = {
            'price_distance_from_50': abs(price - 0.5),
            'day_of_week': 0,
            'price_ma5': price,
            'price_volatility': 0,
            'price_momentum': 0,
            'volume_trend': 0,
            'trade_sequence_num': 1,
            'time_since_last_trade': 0,
            'market_hour': hour,
            'is_weekend': 0,
            'is_business_hours': 1 if 9 <= hour <= 17 else 0,
        }
        defaults.update(kwargs)
        
        # Get feature columns from scaler
        feature_cols = self.scalers['size'].feature_names_in_ if hasattr(self.scalers['size'], 'feature_names_in_') else None
        
        if feature_cols is None:
            features = np.array([[
                price, abs(price - 0.5), hour, defaults['day_of_week'],
                outcome_index, is_cheaper
            ]])
        else:
            feature_values = []
            for col in feature_cols:
                feature_values.append(defaults.get(col, 0))
            features = np.array([feature_values])
        
        features_scaled = self.scalers['size'].transform(features)
        predicted_size = self.models['size'].predict(features_scaled)[0]
        
        return {
            'predicted_usdc_size': predicted_size,
            'predicted_size_tokens': predicted_size / price if price > 0 else 0
        }

def main():
    print("🤖 Advanced Trading Pattern Recognition Model")
    print("=" * 70)
    
    # Initialize model
    model = TradingPatternModel('historical_trades')
    
    # Load data
    trades = model.load_all_trades()
    
    if len(trades) == 0:
        print("❌ No trade data found!")
        return
    
    # Extract features
    df = model.extract_features(trades)
    
    # Analyze patterns
    model.analyze_patterns(df)
    
    # Discover patterns
    patterns = model.discover_patterns(df)
    
    # Train models
    print("\n" + "=" * 70)
    print("🤖 TRAINING MODELS")
    print("=" * 70)
    
    model.train_outcome_prediction_model(df)
    model.train_trade_size_model(df)
    
    # Save models
    print("\n" + "=" * 70)
    print("💾 SAVING MODELS")
    print("=" * 70)
    model.save_models('models')
    
    # Test predictions
    print("\n" + "=" * 70)
    print("🔮 TEST PREDICTIONS")
    print("=" * 70)
    
    test_cases = [
        {'price': 0.35, 'hour': 10, 'size': 10, 'usdc_size': 5},
        {'price': 0.65, 'hour': 15, 'size': 10, 'usdc_size': 5},
        {'price': 0.48, 'hour': 12, 'size': 10, 'usdc_size': 5},
        {'price': 0.42, 'hour': 14, 'size': 20, 'usdc_size': 10},
    ]
    
    for i, test in enumerate(test_cases, 1):
        print(f"\nTest Case {i}: Price=${test['price']:.2f}, Hour={test['hour']}:00")
        outcome_pred = model.predict_outcome(**test)
        if outcome_pred:
            print(f"   Predicted outcome: {outcome_pred['predicted_outcome']}")
            print(f"   Confidence: {outcome_pred['confidence']:.2%}")
            print(f"   Probabilities: {outcome_pred['probabilities']}")
        
        size_pred = model.predict_trade_size(test['price'], test['hour'], 0)
        if size_pred:
            print(f"   Predicted size: ${size_pred['predicted_usdc_size']:.2f} USDC")
    
    print("\n✅ Model training complete!")

if __name__ == '__main__':
    main()
