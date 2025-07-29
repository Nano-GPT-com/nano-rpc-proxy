# Deployment Guide

## 🚀 One Command Deployment

```bash
chmod +x deploy.sh
./deploy.sh
```

**That's it!** This single script automatically:
- 🔍 Detects your setup (Docker SSL, System SSL, or HTTP)
- 📥 Pulls latest code  
- 🔧 Fixes any nginx rate limiting issues
- 🔨 Builds and deploys your containers
- 🧪 Tests all endpoints with and without API key
- 📊 Shows logs and final status

## 🎯 What It Does Automatically

### **SSL Detection:**
- ✅ Finds Docker SSL containers (`nano-rpc-nginx`)
- ✅ Detects SSL certificates (`/etc/letsencrypt/live/rpc.nano-gpt.com/`)
- ✅ Identifies system nginx SSL config
- ✅ Falls back to HTTP if no SSL found

### **Rate Limiting Fix:**
- ✅ Automatically comments out problematic nginx rate limiting
- ✅ Creates backup before making changes
- ✅ Tests and reloads nginx safely

### **Smart Deployment:**
- ✅ Uses `docker-compose.ssl.yml` for Docker SSL
- ✅ Uses `docker-compose.production.yml` for System SSL/HTTP
- ✅ Tests both HTTPS and fallback endpoints

## 🔧 Regular Operations

### **Deploy/Update Everything:**
```bash
./deploy.sh
```

### **Optional: Check Status:**
```bash
./status.sh
```

### **Optional: Run Comprehensive Tests:**
```bash
./test-proxy.sh https://rpc.nano-gpt.com  # Your SSL endpoint
```

### **Optional: SSL Certificate Management:**
```bash
./setup-ssl.sh rpc.nano-gpt.com your@email.com  # Initial SSL setup
./renew-ssl.sh                                   # Renew certificates  
```

## 📊 Architecture Options

### **Option 1: Docker SSL (Containerized)**
- **App Container**: `nano-rpc-proxy-app` (Node.js on port 3000)  
- **Nginx Container**: `nano-rpc-nginx` (SSL termination on 80/443)
- **Certificates**: Let's Encrypt via certbot container

### **Option 2: System SSL (Hybrid)**  
- **App Container**: `nano-rpc-proxy` (Node.js on port 3000)
- **System Nginx**: SSL termination + proxy to container
- **Certificates**: System Let's Encrypt

### **Option 3: HTTP Only**
- **App Container**: `nano-rpc-proxy` (Node.js on port 3000)
- **No SSL**: Direct access or manual nginx setup

## 🔑 API Key Usage

- **With API Key**: No rate limits, access to all RPC commands
- **Without API Key**: Rate limited, only allowed commands

## 🛠️ Troubleshooting

- **"Internal proxy error"**: Run `./fix-system-nginx.sh`
- **Rate limiting with API key**: Check nginx config with `./fix-system-nginx.sh`
- **Container not starting**: Check logs with `./status.sh`

## 📝 Files Explanation

- `deploy.sh` - Main deployment script (use this!)
- `fix-system-nginx.sh` - Fix nginx rate limiting
- `status.sh` - Check service health
- `test-proxy.sh` - Test all functionality
- `docker-compose.production.yml` - Production container setup 