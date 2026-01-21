#!/usr/bin/env python3
"""
ML-Based Trading Algorithm
Uses trained models to make trading decisions based on market conditions
"""

import json
import os
import sys
import joblib
import numpy as np
from datetime import datetime
from typing import Dict, Optional, Tuple

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from tradingPatternModel import TradingPatternModel

class MLTradingAlgorithm:
    def __init__(self, models_dir='models'):
        self.models_dir = models_dir
        self.model = TradingPatternModel()
        self.models_loaded = False
        self.patterns = None
        
    def load_models(self):
        """Load trained models and patterns"""
        if self.models_loaded:
            return True
            
        try:
            # Load models
            outcome_model_path = os.path.join(self.models_dir, 'outcome_model.pkl')
            size_model_path = os.path.join(self.models_dir, 'size_model.pkl')
            outcome_scaler_path = os.path.join(self.models_dir, 'outcome_scaler.pkl')
            size_scaler_path = os.path.join(self.models_dir, 'size_scaler.pkl')
            outcome_encoder_path = os.path.join(self.models_dir, 'outcome_label_encoder.pkl')
            
            if not all(os.path.exists(p) for p in [outcome_model_path, size_model_path, 
                                                   outcome_scaler_path, size_scaler_path, outcome_encoder_path]):
                print(f"Error: Model files not found in {self.models_dir}", file=sys.stderr)
                return False
            
            self.model.models['outcome'] = joblib.load(outcome_model_path)
            self.model.models['size'] = joblib.load(size_model_path)
            self.model.scalers['outcome'] = joblib.load(outcome_scaler_path)
            self.model.scalers['size'] = joblib.load(size_scaler_path)
            self.model.label_encoders['outcome'] = joblib.load(outcome_encoder_path)
            
            # Load patterns
            patterns_path = os.path.join(self.models_dir, 'discovered_patterns.json')
            if os.path.exists(patterns_path):
                with open(patterns_path, 'r') as f:
                    self.patterns = json.load(f)
            
            self.models_loaded = True
            return True
        except Exception as e:
            print(f"Error loading models: {e}", file=sys.stderr)
            return False
    
    def should_execute_trade(self, market_data: Dict) -> Dict:
        """
        Main decision function: Should we execute this trade?
        
        Args:
            market_data: Dictionary containing:
                - price: Current market price (0-1)
                - trader_side: "BUY" or "SELL"
                - trader_outcome: "Up" or "Down" (if buying)
                - trader_size: Trade size in tokens
                - trader_usdc_size: Trade size in USDC
                - timestamp: Unix timestamp
                - market_slug: Market identifier
                - available_balance: Available USDC balance
                - current_position_size: Current position size in USD (optional)
        
        Returns:
            Dictionary with:
                - execute: bool - Whether to execute the trade
                - reason: str - Reason for decision
                - predicted_outcome: str - ML predicted outcome (if buying)
                - confidence: float - Confidence in prediction
                - recommended_size_usd: float - Recommended trade size
                - ml_confidence: float - ML model confidence
        """
        if not self.models_loaded:
            if not self.load_models():
                return {
                    'execute': False,
                    'reason': 'Models not loaded',
                    'predicted_outcome': None,
                    'confidence': 0.0,
                    'recommended_size_usd': 0.0,
                    'ml_confidence': 0.0
                }
        
        price = market_data.get('price', 0.5)
        trader_side = market_data.get('trader_side', 'BUY')
        trader_outcome = market_data.get('trader_outcome', '')
        trader_usdc_size = market_data.get('trader_usdc_size', 0)
        timestamp = market_data.get('timestamp', 0)
        available_balance = market_data.get('available_balance', 0)
        current_position_size = market_data.get('current_position_size', 0)
        
        # Extract time features
        dt = datetime.fromtimestamp(timestamp) if timestamp else datetime.now()
        hour = dt.hour
        day_of_week = dt.weekday()
        
        # Only process BUY orders (SELL/MERGE handled separately)
        if trader_side != 'BUY':
            return {
                'execute': True,  # Execute SELL/MERGE as-is
                'reason': 'SELL/MERGE order - execute as-is',
                'predicted_outcome': None,
                'confidence': 1.0,
                'recommended_size_usd': trader_usdc_size,
                'ml_confidence': 1.0
            }
        
        # Rule 1: Price validation
        if price <= 0 or price >= 1:
            return {
                'execute': False,
                'reason': f'Invalid price: {price}',
                'predicted_outcome': None,
                'confidence': 0.0,
                'recommended_size_usd': 0.0,
                'ml_confidence': 0.0
            }
        
        # Rule 2: Use ML to predict outcome
        outcome_prediction = self.model.predict_outcome(
            price=price,
            hour=hour,
            size=market_data.get('trader_size', 0),
            usdc_size=trader_usdc_size,
            day_of_week=day_of_week
        )
        
        if not outcome_prediction:
            return {
                'execute': False,
                'reason': 'ML model prediction failed',
                'predicted_outcome': None,
                'confidence': 0.0,
                'recommended_size_usd': 0.0,
                'ml_confidence': 0.0
            }
        
        predicted_outcome = outcome_prediction['predicted_outcome']
        ml_confidence = outcome_prediction['confidence']
        
        # Rule 3: Check if trader's outcome matches ML prediction
        outcome_match = (trader_outcome == predicted_outcome) if trader_outcome else True
        
        # Rule 4: Implement discovered pattern - prefer cheaper outcome
        is_cheaper = (predicted_outcome == 'Up' and price < 0.5) or \
                     (predicted_outcome == 'Down' and price > 0.5)
        
        # Rule 5: Time-based filtering (most active hours: 10, 23, 8, 5, 3)
        active_hours = [3, 5, 8, 10, 23]
        is_active_hour = hour in active_hours
        
        # Rule 6: Confidence threshold
        min_confidence = 0.85  # Require 85% confidence
        
        # Rule 7: Size validation using ML
        outcome_index = 0 if predicted_outcome == 'Up' else 1
        size_prediction = self.model.predict_trade_size(
            price=price,
            hour=hour,
            outcome_index=outcome_index,
            day_of_week=day_of_week
        )
        
        if size_prediction:
            recommended_size = size_prediction['predicted_usdc_size']
            # Use average of trader size and ML prediction, but respect limits
            recommended_size = (trader_usdc_size + recommended_size) / 2
        else:
            recommended_size = trader_usdc_size
        
        # Apply safety limits
        max_size = min(available_balance * 0.95, recommended_size)  # 5% safety buffer
        min_size = 1.0  # Minimum $1
        
        if recommended_size < min_size:
            recommended_size = 0
        
        # Decision logic
        execute = False
        reasons = []
        
        # High confidence ML prediction
        if ml_confidence >= min_confidence:
            reasons.append(f'High ML confidence ({ml_confidence:.1%})')
            execute = True
        
        # Outcome matches prediction
        if outcome_match:
            reasons.append('Trader outcome matches ML prediction')
            execute = True
        else:
            reasons.append(f'Trader outcome ({trader_outcome}) differs from ML ({predicted_outcome})')
            # Still execute if confidence is very high
            if ml_confidence >= 0.95:
                reasons.append('Executing despite mismatch due to very high confidence')
                execute = True
        
        # Cheaper outcome preference
        if is_cheaper:
            reasons.append('Buying cheaper outcome (pattern match)')
        else:
            reasons.append('Not buying cheaper outcome')
            # Reduce confidence if not cheaper
            if ml_confidence < 0.90:
                execute = False
                reasons.append('Low confidence + not cheaper = skip')
        
        # Active hour bonus
        if is_active_hour:
            reasons.append(f'Active trading hour ({hour}:00)')
        else:
            reasons.append(f'Less active hour ({hour}:00)')
            # Slightly reduce confidence outside active hours
            if ml_confidence < 0.90:
                execute = False
                reasons.append('Low confidence + inactive hour = skip')
        
        # Size validation
        if recommended_size < min_size:
            execute = False
            reasons.append(f'Recommended size (${recommended_size:.2f}) below minimum (${min_size})')
        elif recommended_size > available_balance * 0.95:
            recommended_size = available_balance * 0.95
            reasons.append(f'Capped size to available balance')
        
        # Final decision
        if execute:
            reason = ' | '.join(reasons)
        else:
            reason = ' | '.join(reasons)
        
        return {
            'execute': execute,
            'reason': reason,
            'predicted_outcome': predicted_outcome,
            'confidence': ml_confidence,
            'recommended_size_usd': max(0, recommended_size),
            'ml_confidence': ml_confidence,
            'is_cheaper_outcome': is_cheaper,
            'is_active_hour': is_active_hour,
            'outcome_match': outcome_match
        }
    
    def get_trade_recommendation(self, market_data: Dict) -> Dict:
        """
        Get detailed trade recommendation without execution decision
        
        Returns:
            Dictionary with all analysis and recommendations
        """
        decision = self.should_execute_trade(market_data)
        
        # Add additional analysis
        price = market_data.get('price', 0.5)
        hour = datetime.fromtimestamp(market_data.get('timestamp', 0)).hour if market_data.get('timestamp') else datetime.now().hour
        
        recommendation = {
            **decision,
            'analysis': {
                'price': price,
                'price_distance_from_50': abs(price - 0.5),
                'hour': hour,
                'is_cheaper_outcome': decision.get('is_cheaper_outcome', False),
                'is_active_hour': decision.get('is_active_hour', False),
            }
        }
        
        # Add pattern insights if available
        if self.patterns:
            recommendation['patterns'] = {
                'avg_trade_size': self.patterns.get('size_based', {}).get('mean_size', 0),
                'most_active_hours': list(self.patterns.get('time_based', {}).get('most_active_hours', {}).keys())[:5]
            }
        
        return recommendation

def main():
    """CLI interface - reads JSON from stdin"""
    import sys
    
    algorithm = MLTradingAlgorithm()
    if not algorithm.load_models():
        print(json.dumps({
            'execute': False,
            'reason': 'Models not loaded',
            'predicted_outcome': None,
            'confidence': 0.0,
            'recommended_size_usd': 0.0,
            'ml_confidence': 0.0
        }), file=sys.stderr)
        sys.exit(1)
    
    try:
        # Read JSON from stdin
        input_data = sys.stdin.read()
        if not input_data:
            raise ValueError("No input data")
        
        market_data = json.loads(input_data)
        decision = algorithm.should_execute_trade(market_data)
        print(json.dumps(decision))
    except json.JSONDecodeError as e:
        print(json.dumps({
            'execute': False,
            'reason': f'Invalid JSON: {str(e)}',
            'predicted_outcome': None,
            'confidence': 0.0,
            'recommended_size_usd': 0.0,
            'ml_confidence': 0.0
        }), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            'execute': False,
            'reason': f'Error: {str(e)}',
            'predicted_outcome': None,
            'confidence': 0.0,
            'recommended_size_usd': 0.0,
            'ml_confidence': 0.0
        }), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
