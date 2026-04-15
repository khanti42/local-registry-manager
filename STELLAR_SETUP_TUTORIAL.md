# Stellar Integration Setup Tutorial

## The Story: Why This Setup?

We're integrating **Stellar** support into MetaMask—an ambitious project that brings blockchain interoperability to the MetaMask ecosystem. This isn't a simple plugin; it requires coordinating multiple repositories across the MetaMask organization and our own local tooling.

### What We're Building
- **MetaMask Snap for Stellar**: A secure execution environment that handles Stellar wallet operations
- **Keyring API Integration**: Custom signing and account management for Stellar accounts
- **Local Development Registry**: A local npm registry to test unpublished packages in isolation before pushing to production

### Why This Approach?
The repositories are in active development on feature branches (`feat/stellar-integration`). To test everything together without polluting the production npm registry, we use a **local registry** that lets us publish and test our changes in a controlled environment. This is the gold standard for multi-package development workflows.

---

## Prerequisites

Before running the setup script, ensure you have:
- **Node.js** (v16+) and **yarn** installed
- **Git** installed and configured
- About **5GB of disk space** for all repositories
- **Linux/macOS** (script uses bash)

---

## The Setup Script

This automated script will:
1. Create an isolated directory for all Stellar integration code
2. Clone all required repositories on their feature branches
3. Install dependencies and build necessary packages
4. Set up the local registry manager

### Running the Script

```bash
# Copy the script to a file
nano stellar-setup.sh
# Paste the script below, then save (Ctrl+X, Y, Enter)

# Make it executable
chmod +x stellar-setup.sh

# Run it
./stellar-setup.sh
```

### The Script

```bash
echo "Setting up development environment for Stellar integration"
echo "--------------------------------------------------------"
echo "1. Creating a new directory for the stellar integration"
echo "2. Cloning the metamask extension"
echo "3. Cloning the snap-stellar-wallet"
echo "4. Cloning the core"
echo "5. Cloning the accounts"
echo "6. Cloning the local registry manager"
echo "--------------------------------------------------------"

read -p "Do you want to continue? (y/n): " continue
if [ "$continue" != "y" ]; then
    echo "Exiting..."
    exit 1
fi

# Create a new directory for the stellar integration
mkdir stellar_integration 
cd stellar_integration

# Clone the metamask extension
# Clone only one branch of the metamask extension
git clone -b feat/stellar-integration --single-branch --depth 3 https://github.com/MetaMask/metamask-extension.git

# Clone the snap-stellar-wallet
git clone -b feat/stellar-integration https://github.com/MetaMask/snap-stellar-wallet.git
cd snap-stellar-wallet
cp packages/snap/.env.example packages/snap/.env
cd ..

# Clone the core
git clone -b feat/stellar-integration https://github.com/MetaMask/core.git
cd core 
git checkout main
yarn 
yarn build 
git checkout feat/stellar-integration
cd ..

# Clone the accounts
git clone -b feat/stellar-integration https://github.com/MetaMask/accounts.git
cd accounts 
yarn 
yarn build 
cd ..

# Clone the local registry manager
git clone https://github.com/khanti42/local-registry-manager.git
cd local-registry-manager
yarn 

echo "Setup complete" 
echo "--------------------------------------------------------"
echo "" 
echo "Next steps:" 
echo "1. Install verdaccio globally with npm install -g verdaccio"
echo "2. Start the local npm registry verdaccio"
echo "3. Create a new user with npm adduser --registry http://localhost:4873"
echo "4. Login with the new user with npm login --registry http://localhost:4873"
echo "5. Run the local registry manager with" 
echo "    cd stellar_integration/local-registry-manager"
echo "    yarn registry apply --changed @metamask/keyring-api,@metamask/keyring-internal-api,@metamask/eth-snap-keyring,@metamask/eth-hd-keyring,@metamask/stellar-wallet-snap --include-repo core --sync-registry-resolutions"
echo "6. You can now run the extension with yarn start"
```

---

## What's Happening Behind the Scenes

### 1. **Directory Structure**
```
stellar_integration/
├── metamask-extension/      # The MetaMask browser extension UI
├── snap-stellar-wallet/     # Stellar-specific snap implementation
├── core/                    # Core MetaMask keyring and account management
├── accounts/                # Account management layer
└── local-registry-manager/  # Our tool to sync packages across repos
```

### 2. **Key Steps Explained**

#### Cloning with `--single-branch --depth 3`
```bash
git clone -b feat/stellar-integration --single-branch --depth 3 https://github.com/MetaMask/metamask-extension.git
```
- `--single-branch`: Only fetch the `feat/stellar-integration` branch (faster)
- `--depth 3`: Only fetch the last 3 commits (minimal history)
- **Why?** MetaMask repos are massive; this keeps your clone lightweight

#### Building Core First
```bash
cd core 
git checkout main
yarn 
yarn build 
git checkout feat/stellar-integration
```
- We build from `main` first to establish a baseline
- Then switch to our feature branch
- **Why?** Ensures dependencies are fresh and avoids version conflicts

#### The Local Registry Manager
```bash
git clone https://github.com/khanti42/local-registry-manager.git
cd local-registry-manager
yarn
```
- **What is it?** A tool that publishes our unpublished packages to a local npm registry
- **Why?** So the extension can install our work-in-progress keyrings without touching npm

---

## After the Script: Setting Up Verdaccio

Once the script completes, you'll set up a **local npm registry** using Verdaccio.

### Step 1: Install Verdaccio Globally
```bash
npm install -g verdaccio
```

### Step 2: Start Verdaccio
```bash
verdaccio
# Output: 
# http://localhost:4873/ - Local npm registry
# Press Ctrl+C to stop
```
Leave this running in a terminal tab.

### Step 3: Create a Local Registry User
```bash
npm adduser --registry http://localhost:4873
```
Follow the prompts to create a username and password.

### Step 4: Login
```bash
npm login --registry http://localhost:4873
```

### Step 5: Publish Your Packages to Local Registry
```bash
cd stellar_integration/local-registry-manager
yarn registry apply \
  --changed @metamask/keyring-api,@metamask/keyring-internal-api,@metamask/eth-snap-keyring,@metamask/eth-hd-keyring,@metamask/stellar-wallet-snap \
  --include-repo core \
  --sync-registry-resolutions
```

**What does this do?**
- `--changed`: List of packages to publish
- `--include-repo core`: Include packages from the core repository
- `--sync-registry-resolutions`: Ensure version consistency across all packages

### Step 6: Start the Extension
```bash
cd stellar_integration/metamask-extension
yarn start
```

This launches MetaMask with Stellar support using your locally published packages.

---

## Troubleshooting

### Issue: `git clone` fails with permission denied
**Solution:** Make sure you have GitHub access or use SSH keys configured.

### Issue: `yarn build` fails with dependency errors
**Solution:** Clear yarn cache and retry:
```bash
yarn cache clean
yarn
yarn build
```

### Issue: Verdaccio won't start
**Solution:** Port 4873 might be in use. Stop other services or specify a different port:
```bash
verdaccio --listen 4874
```

### Issue: `yarn registry apply` fails
**Solution:** Make sure you're logged in to verdaccio:
```bash
npm login --registry http://localhost:4873
```

---

## Next Steps

Once you have everything running:
1. **Develop locally** – Edit files in any repository; yarn watches for changes
2. **Test the snap** – Use MetaMask DevTools to test Stellar transactions
3. **Iterate** – Changes to core/accounts/snap automatically rebuild
4. **Publish when ready** – Once stable, publish to npm for production use

---

## Questions?

This is a complex setup. If something doesn't work, check:
- GitHub issues in each repository
- Local registry manager documentation: https://github.com/khanti42/local-registry-manager
- MetaMask Snap documentation: https://docs.metamask.io/snaps/

Happy coding! 🚀
