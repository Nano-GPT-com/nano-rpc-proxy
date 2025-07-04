#!/bin/bash

# Setup automatic SSL certificate renewal via cron

PROJECT_DIR=$(pwd)

echo "⏰ Setting up automatic SSL certificate renewal..."

# Create cron job that runs twice daily
(crontab -l 2>/dev/null; echo "0 2,14 * * * $PROJECT_DIR/renew-ssl.sh >> $PROJECT_DIR/ssl-renewal.log 2>&1") | crontab -

echo "✅ Cron job added successfully!"
echo "📅 Certificates will be checked for renewal twice daily (2 AM and 2 PM)"
echo "📝 Renewal logs will be written to: $PROJECT_DIR/ssl-renewal.log"
echo ""
echo "🔍 To view current cron jobs:"
echo "   crontab -l"
echo ""
echo "📋 To manually test renewal:"
echo "   ./renew-ssl.sh"