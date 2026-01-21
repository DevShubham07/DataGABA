#!/usr/bin/env python3
"""
Analyze historical trades and create a price split JSON showing spending
across Up/Down positions for each market.
"""

import json
import os
from collections import defaultdict
from pathlib import Path

def analyze_trades():
    """Analyze all trade JSON files and create price split summary."""
    
    historical_trades_dir = Path("historical_trades")
    
    # Dictionary to track spending per market
    # Structure: {market_slug: {"up": total_up, "down": total_down, "total": total}}
    market_data = defaultdict(lambda: {"up": 0.0, "down": 0.0, "total": 0.0})
    
    # Overall totals
    overall_totals = {"up": 0.0, "down": 0.0, "total": 0.0}
    
    # Get all JSON files
    json_files = sorted(historical_trades_dir.glob("*.json"))
    
    print(f"Found {len(json_files)} JSON files to process...")
    
    for json_file in json_files:
        try:
            with open(json_file, 'r') as f:
                data = json.load(f)
            
            # Handle case where file might not be a list
            if not isinstance(data, list):
                print(f"Skipping {json_file.name}: not a list format")
                continue
            
            for trade in data:
                # Ensure trade is a dictionary
                if not isinstance(trade, dict):
                    continue
                
                # Only process BUY trades (spending money)
                if trade.get("side") != "BUY":
                    continue
                
                usdc_size = trade.get("usdcSize", 0.0)
                outcome = trade.get("outcome", "").strip()
                slug = trade.get("slug", "")
                
                if not slug:
                    continue
                
                # Add to market totals
                if outcome.lower() == "up":
                    market_data[slug]["up"] += usdc_size
                    overall_totals["up"] += usdc_size
                elif outcome.lower() == "down":
                    market_data[slug]["down"] += usdc_size
                    overall_totals["down"] += usdc_size
                
                market_data[slug]["total"] += usdc_size
                overall_totals["total"] += usdc_size
                
        except Exception as e:
            print(f"Error processing {json_file.name}: {e}")
            continue
    
    # Create the output structure
    output = {
        "overall": {
            "up": round(overall_totals["up"], 2),
            "down": round(overall_totals["down"], 2),
            "total": round(overall_totals["total"], 2)
        },
        "markets": {}
    }
    
    # Add each market's data
    for slug, data in sorted(market_data.items()):
        output["markets"][slug] = {
            "up": round(data["up"], 2),
            "down": round(data["down"], 2),
            "total": round(data["total"], 2)
        }
    
    # Write to JSON file
    output_file = "pricesplit.json"
    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\nAnalysis complete!")
    print(f"Total markets analyzed: {len(market_data)}")
    print(f"Overall spending:")
    print(f"  Up: ${overall_totals['up']:,.2f}")
    print(f"  Down: ${overall_totals['down']:,.2f}")
    print(f"  Total: ${overall_totals['total']:,.2f}")
    print(f"\nResults saved to: {output_file}")
    
    return output

if __name__ == "__main__":
    analyze_trades()
