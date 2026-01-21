#!/usr/bin/env python3
"""
Analyze buying patterns across all JSON files in historical_trades directory.
Focuses on BUY transactions for Up/Down tokens.
"""

import json
import os
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import seaborn as sns
import pandas as pd
import numpy as np

# Set style
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (14, 8)

def load_all_trades(directory):
    """Load all trade data from JSON files."""
    all_trades = []
    files_processed = 0
    
    trade_dir = Path(directory)
    for json_file in trade_dir.glob("*.json"):
        # Skip firsttimestamp.json as it has different structure
        if json_file.name == "firsttimestamp.json":
            continue
            
        try:
            with open(json_file, 'r') as f:
                data = json.load(f)
                # Handle both array and object formats
                if isinstance(data, list):
                    trades = data
                elif isinstance(data, dict):
                    # Skip if it's the firsttimestamp structure
                    continue
                else:
                    continue
                
                # Filter for BUY transactions only
                buy_trades = [t for t in trades if t.get('side') == 'BUY']
                all_trades.extend(buy_trades)
                files_processed += 1
        except Exception as e:
            print(f"Error processing {json_file.name}: {e}")
            continue
    
    print(f"Processed {files_processed} files")
    print(f"Total BUY transactions: {len(all_trades)}")
    return all_trades

def analyze_patterns(trades):
    """Analyze buying patterns."""
    # Convert to DataFrame for easier analysis
    df = pd.DataFrame(trades)
    
    # Convert timestamp to datetime
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='s')
    df['date'] = df['datetime'].dt.date
    df['hour'] = df['datetime'].dt.hour
    df['day_of_week'] = df['datetime'].dt.day_name()
    
    # Normalize outcome (Up/Down)
    df['outcome_normalized'] = df['outcome'].str.strip().str.title()
    
    # Filter to only Up/Down
    df = df[df['outcome_normalized'].isin(['Up', 'Down'])]
    
    print(f"\nTotal Up/Down BUY transactions: {len(df)}")
    print(f"Up transactions: {len(df[df['outcome_normalized'] == 'Up'])}")
    print(f"Down transactions: {len(df[df['outcome_normalized'] == 'Down'])}")
    
    return df

def create_diagrams(df, output_dir):
    """Create multiple analysis diagrams."""
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)
    
    # 1. Overall Distribution: Up vs Down
    fig, ax = plt.subplots(figsize=(10, 6))
    outcome_counts = df['outcome_normalized'].value_counts()
    colors = ['#2ecc71', '#e74c3c']  # Green for Up, Red for Down
    bars = ax.bar(outcome_counts.index, outcome_counts.values, color=colors, alpha=0.7, edgecolor='black')
    ax.set_title('Overall Distribution: Up vs Down BUY Transactions', fontsize=16, fontweight='bold')
    ax.set_xlabel('Outcome', fontsize=12)
    ax.set_ylabel('Number of Transactions', fontsize=12)
    ax.grid(axis='y', alpha=0.3)
    
    # Add value labels on bars
    for bar in bars:
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width()/2., height,
                f'{int(height)}',
                ha='center', va='bottom', fontsize=12, fontweight='bold')
    
    plt.tight_layout()
    plt.savefig(output_path / '1_overall_distribution.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 2. Volume Distribution (USDC Size)
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    
    up_trades = df[df['outcome_normalized'] == 'Up']
    down_trades = df[df['outcome_normalized'] == 'Down']
    
    axes[0].hist(up_trades['usdcSize'], bins=50, color='#2ecc71', alpha=0.7, edgecolor='black')
    axes[0].set_title('USDC Size Distribution - UP Buys', fontsize=14, fontweight='bold')
    axes[0].set_xlabel('USDC Size', fontsize=12)
    axes[0].set_ylabel('Frequency', fontsize=12)
    axes[0].grid(axis='y', alpha=0.3)
    
    axes[1].hist(down_trades['usdcSize'], bins=50, color='#e74c3c', alpha=0.7, edgecolor='black')
    axes[1].set_title('USDC Size Distribution - DOWN Buys', fontsize=14, fontweight='bold')
    axes[1].set_xlabel('USDC Size', fontsize=12)
    axes[1].set_ylabel('Frequency', fontsize=12)
    axes[1].grid(axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path / '2_volume_distribution.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 3. Price Distribution
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    
    axes[0].hist(up_trades['price'], bins=50, color='#2ecc71', alpha=0.7, edgecolor='black')
    axes[0].set_title('Price Distribution - UP Buys', fontsize=14, fontweight='bold')
    axes[0].set_xlabel('Price', fontsize=12)
    axes[0].set_ylabel('Frequency', fontsize=12)
    axes[0].grid(axis='y', alpha=0.3)
    
    axes[1].hist(down_trades['price'], bins=50, color='#e74c3c', alpha=0.7, edgecolor='black')
    axes[1].set_title('Price Distribution - DOWN Buys', fontsize=14, fontweight='bold')
    axes[1].set_xlabel('Price', fontsize=12)
    axes[1].set_ylabel('Frequency', fontsize=12)
    axes[1].grid(axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path / '3_price_distribution.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 4. Temporal Patterns - Over Time
    fig, ax = plt.subplots(figsize=(16, 6))
    
    df_sorted = df.sort_values('datetime')
    df_sorted['cumulative_up'] = (df_sorted['outcome_normalized'] == 'Up').cumsum()
    df_sorted['cumulative_down'] = (df_sorted['outcome_normalized'] == 'Down').cumsum()
    
    ax.plot(df_sorted['datetime'], df_sorted['cumulative_up'], 
            label='Cumulative UP Buys', color='#2ecc71', linewidth=2)
    ax.plot(df_sorted['datetime'], df_sorted['cumulative_down'], 
            label='Cumulative DOWN Buys', color='#e74c3c', linewidth=2)
    
    ax.set_title('Cumulative BUY Transactions Over Time', fontsize=16, fontweight='bold')
    ax.set_xlabel('Date', fontsize=12)
    ax.set_ylabel('Cumulative Count', fontsize=12)
    ax.legend(fontsize=12)
    ax.grid(alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=1))
    plt.xticks(rotation=45)
    
    plt.tight_layout()
    plt.savefig(output_path / '4_temporal_cumulative.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 5. Hourly Pattern
    fig, ax = plt.subplots(figsize=(14, 6))
    
    hourly_up = df[df['outcome_normalized'] == 'Up'].groupby('hour').size()
    hourly_down = df[df['outcome_normalized'] == 'Down'].groupby('hour').size()
    
    x = np.arange(24)
    width = 0.35
    
    ax.bar(x - width/2, [hourly_up.get(h, 0) for h in x], width, 
           label='UP', color='#2ecc71', alpha=0.7, edgecolor='black')
    ax.bar(x + width/2, [hourly_down.get(h, 0) for h in x], width, 
           label='DOWN', color='#e74c3c', alpha=0.7, edgecolor='black')
    
    ax.set_title('BUY Transactions by Hour of Day', fontsize=16, fontweight='bold')
    ax.set_xlabel('Hour (24-hour format)', fontsize=12)
    ax.set_ylabel('Number of Transactions', fontsize=12)
    ax.set_xticks(x)
    ax.legend(fontsize=12)
    ax.grid(axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path / '5_hourly_pattern.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 6. Day of Week Pattern
    fig, ax = plt.subplots(figsize=(12, 6))
    
    day_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    day_up = df[df['outcome_normalized'] == 'Up'].groupby('day_of_week').size().reindex(day_order, fill_value=0)
    day_down = df[df['outcome_normalized'] == 'Down'].groupby('day_of_week').size().reindex(day_order, fill_value=0)
    
    x = np.arange(len(day_order))
    width = 0.35
    
    ax.bar(x - width/2, day_up.values, width, label='UP', color='#2ecc71', alpha=0.7, edgecolor='black')
    ax.bar(x + width/2, day_down.values, width, label='DOWN', color='#e74c3c', alpha=0.7, edgecolor='black')
    
    ax.set_title('BUY Transactions by Day of Week', fontsize=16, fontweight='bold')
    ax.set_xlabel('Day of Week', fontsize=12)
    ax.set_ylabel('Number of Transactions', fontsize=12)
    ax.set_xticks(x)
    ax.set_xticklabels(day_order, rotation=45, ha='right')
    ax.legend(fontsize=12)
    ax.grid(axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path / '6_day_of_week_pattern.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 7. Sequential Pattern Analysis (Transitions)
    fig, ax = plt.subplots(figsize=(12, 8))
    
    # Get sequential transitions
    transitions = []
    for market in df['slug'].unique():
        market_trades = df[df['slug'] == market].sort_values('timestamp')
        outcomes = market_trades['outcome_normalized'].tolist()
        for i in range(len(outcomes) - 1):
            transitions.append((outcomes[i], outcomes[i+1]))
    
    transition_counts = Counter(transitions)
    
    # Create transition matrix
    transition_matrix = pd.DataFrame({
        'From Up': [
            transition_counts.get(('Up', 'Up'), 0),
            transition_counts.get(('Down', 'Up'), 0)
        ],
        'From Down': [
            transition_counts.get(('Up', 'Down'), 0),
            transition_counts.get(('Down', 'Down'), 0)
        ]
    }, index=['To Up', 'To Down'])
    
    sns.heatmap(transition_matrix, annot=True, fmt='d', cmap='RdYlGn', 
                cbar_kws={'label': 'Count'}, ax=ax, linewidths=1, linecolor='black')
    ax.set_title('Transition Matrix: Sequential BUY Patterns\n(Up/Down → Up/Down)', 
                 fontsize=16, fontweight='bold')
    ax.set_xlabel('From', fontsize=12)
    ax.set_ylabel('To', fontsize=12)
    
    plt.tight_layout()
    plt.savefig(output_path / '7_transition_matrix.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 8. Average Price by Outcome
    fig, ax = plt.subplots(figsize=(10, 6))
    
    avg_price_up = up_trades['price'].mean()
    avg_price_down = down_trades['price'].mean()
    std_price_up = up_trades['price'].std()
    std_price_down = down_trades['price'].std()
    
    bars = ax.bar(['UP', 'DOWN'], [avg_price_up, avg_price_down], 
                  color=['#2ecc71', '#e74c3c'], alpha=0.7, edgecolor='black',
                  yerr=[std_price_up, std_price_down], capsize=10)
    
    ax.set_title('Average Price by Outcome (with Std Dev)', fontsize=16, fontweight='bold')
    ax.set_ylabel('Average Price', fontsize=12)
    ax.set_xlabel('Outcome', fontsize=12)
    ax.grid(axis='y', alpha=0.3)
    
    # Add value labels
    for i, bar in enumerate(bars):
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width()/2., height,
                f'{height:.3f}',
                ha='center', va='bottom', fontsize=12, fontweight='bold')
    
    plt.tight_layout()
    plt.savefig(output_path / '8_average_price.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 9. Average Volume by Outcome
    fig, ax = plt.subplots(figsize=(10, 6))
    
    avg_volume_up = up_trades['usdcSize'].mean()
    avg_volume_down = down_trades['usdcSize'].mean()
    std_volume_up = up_trades['usdcSize'].std()
    std_volume_down = down_trades['usdcSize'].std()
    
    bars = ax.bar(['UP', 'DOWN'], [avg_volume_up, avg_volume_down], 
                  color=['#2ecc71', '#e74c3c'], alpha=0.7, edgecolor='black',
                  yerr=[std_volume_up, std_volume_down], capsize=10)
    
    ax.set_title('Average Volume (USDC) by Outcome (with Std Dev)', fontsize=16, fontweight='bold')
    ax.set_ylabel('Average USDC Size', fontsize=12)
    ax.set_xlabel('Outcome', fontsize=12)
    ax.grid(axis='y', alpha=0.3)
    
    # Add value labels
    for i, bar in enumerate(bars):
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width()/2., height,
                f'${height:.2f}',
                ha='center', va='bottom', fontsize=12, fontweight='bold')
    
    plt.tight_layout()
    plt.savefig(output_path / '9_average_volume.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 10. Price vs Volume Scatter
    fig, ax = plt.subplots(figsize=(12, 8))
    
    ax.scatter(up_trades['price'], up_trades['usdcSize'], 
              alpha=0.5, color='#2ecc71', label='UP', s=50, edgecolors='black', linewidths=0.5)
    ax.scatter(down_trades['price'], down_trades['usdcSize'], 
              alpha=0.5, color='#e74c3c', label='DOWN', s=50, edgecolors='black', linewidths=0.5)
    
    ax.set_title('Price vs Volume Scatter Plot', fontsize=16, fontweight='bold')
    ax.set_xlabel('Price', fontsize=12)
    ax.set_ylabel('USDC Size', fontsize=12)
    ax.legend(fontsize=12)
    ax.grid(alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path / '10_price_volume_scatter.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    # 11. Summary Statistics Table
    summary_stats = {
        'Metric': [
            'Total Transactions',
            'UP Transactions',
            'DOWN Transactions',
            'UP Percentage',
            'DOWN Percentage',
            'Avg Price (UP)',
            'Avg Price (DOWN)',
            'Avg Volume (UP)',
            'Avg Volume (DOWN)',
            'Total Volume (UP)',
            'Total Volume (DOWN)'
        ],
        'Value': [
            len(df),
            len(up_trades),
            len(down_trades),
            f"{len(up_trades)/len(df)*100:.2f}%",
            f"{len(down_trades)/len(df)*100:.2f}%",
            f"${avg_price_up:.4f}",
            f"${avg_price_down:.4f}",
            f"${avg_volume_up:.2f}",
            f"${avg_volume_down:.2f}",
            f"${up_trades['usdcSize'].sum():.2f}",
            f"${down_trades['usdcSize'].sum():.2f}"
        ]
    }
    
    summary_df = pd.DataFrame(summary_stats)
    fig, ax = plt.subplots(figsize=(12, 8))
    ax.axis('tight')
    ax.axis('off')
    table = ax.table(cellText=summary_df.values, colLabels=summary_df.columns,
                    cellLoc='center', loc='center', bbox=[0, 0, 1, 1])
    table.auto_set_font_size(False)
    table.set_fontsize(11)
    table.scale(1, 2)
    
    # Style the header
    for i in range(len(summary_df.columns)):
        table[(0, i)].set_facecolor('#34495e')
        table[(0, i)].set_text_props(weight='bold', color='white')
    
    ax.set_title('Summary Statistics', fontsize=16, fontweight='bold', pad=20)
    
    plt.tight_layout()
    plt.savefig(output_path / '11_summary_statistics.png', dpi=300, bbox_inches='tight')
    plt.close()
    
    print(f"\nGenerated {len(list(output_path.glob('*.png')))} diagrams in {output_dir}/")

def main():
    """Main execution function."""
    trade_directory = "historical_trades"
    output_directory = "diagram"
    
    print("Loading trade data...")
    trades = load_all_trades(trade_directory)
    
    if not trades:
        print("No trades found!")
        return
    
    print("\nAnalyzing patterns...")
    df = analyze_patterns(trades)
    
    if len(df) == 0:
        print("No Up/Down transactions found!")
        return
    
    print("\nGenerating diagrams...")
    create_diagrams(df, output_directory)
    
    print("\nAnalysis complete!")

if __name__ == "__main__":
    main()
