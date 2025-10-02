# PlayStation API Setup Guide

This guide explains how to set up the PlayStation gaming activity feature for your GitHub profile.

## 🎮 Features

- **Recent Games**: Shows your currently playing games with progress
- **Trophy Tracking**: Displays your recent trophy achievements  
- **Gaming Stats**: PSN level, total trophies, and game completion stats
- **Auto-Updates**: Refreshes every 4 hours via GitHub Actions

## 🔧 Setup Instructions

### Option 1: Use Sample Data (No Setup Required)
The workflow will automatically use sample gaming data if no PSN tokens are configured.

### Option 2: Connect Real PlayStation Data

To show your actual PlayStation gaming activity, you'll need to set up PSN API access:

#### Step 1: Get PSN API Access
1. Use a community PSN API library like:
   - [psn-api](https://github.com/achievements-app/psn-api) (Node.js)
   - [psn-php](https://github.com/Ragowit/psn-php) (PHP)

#### Step 2: Get Your NPSSO Token
1. Visit [PlayStation Store](https://store.playstation.com) in your browser
2. Sign in to your PlayStation account
3. Open browser developer tools (F12)
4. Go to Application/Storage → Cookies → https://store.playstation.com
5. Find the cookie named `npsso` and copy its value

#### Step 3: Configure Repository Secret
Add this secret to your GitHub repository:

**Secret Name:** `PSN_ACCESS`
**Secret Value:**
```json
{"npsso":"your_npsso_token_here"}
```

**To add the secret:**
1. Go to your repository Settings
2. Click "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Name: `PSN_ACCESS`
5. Value: `{"npsso":"your_actual_npsso_token"}`

#### Step 4: Manual Trigger
1. Go to Actions tab in your repository
2. Find "PlayStation Gaming Activity" workflow
3. Click "Run workflow" to test

## 🎯 Customization

### Game Emojis
Edit the `getGameEmoji()` function in the workflow to add custom emojis for your games.

### Update Frequency
Change the cron schedule in the workflow:
- Every 2 hours: `0 */2 * * *`
- Daily: `0 0 * * *`
- Weekly: `0 0 * * 0`

### Display Format
Modify the output format in the `main()` function to customize how games and trophies are displayed.

## 🔒 Privacy & Security

- Only public PlayStation data is accessed
- Tokens are stored securely as GitHub repository secrets
- No sensitive information is logged or committed
- You can disable the feature anytime by removing the secrets

## 🛠️ Troubleshooting

**No Data Showing?**
- Check if PSN_ACCESS secret is set with valid NPSSO token
- Verify the JSON format: `{"npsso":"your_token"}`
- Ensure your PlayStation privacy settings allow public access
- Run the workflow manually to check for errors

**NPSSO Token Issues?**
- Token may have expired - get a fresh one from PlayStation Store
- Make sure you copied the full token value
- Verify JSON format is correct (no extra spaces or characters)

**Old Data?**
- The workflow updates every 4 hours
- Run manually for immediate updates
- Check Actions tab for any failed runs

## 📞 Support

If you encounter issues:
1. Check the workflow logs in the Actions tab
2. Verify your PSN API setup
3. Test with sample data first

---

**Note**: This uses community-developed PSN APIs and is not officially affiliated with Sony Interactive Entertainment.
