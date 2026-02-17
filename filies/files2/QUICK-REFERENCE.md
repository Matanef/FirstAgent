# ⚡ QUICK REFERENCE - File Replacement Checklist

## 📁 Files to Replace (Copy Over)

### Server Core (5 files)
```
✅ index-corrected.js       →  server/index.js
✅ planner-corrected.js     →  server/planner.js
✅ executor-corrected.js    →  server/executor.js
✅ weather-corrected.js     →  server/tools/weather.js
✅ config-corrected.js      →  server/utils/config.js
```

### Client UI (2 files)
```
✅ App-enhanced.jsx         →  client/local-llm-ui/src/App.jsx
✅ App-enhanced.css         →  client/local-llm-ui/src/App.css
```

### Self-Improvement Tools (3 NEW files)
```
✅ fileWrite.js             →  server/tools/fileWrite.js
✅ webDownload.js           →  server/tools/webDownload.js
✅ packageManager.js        →  server/tools/packageManager.js
```

## 📝 File to Edit (1 file)

Edit `server/tools/index.js` - Add these 3 lines:

```javascript
import { fileWrite } from "./fileWrite.js";
import { webDownload } from "./webDownload.js";
import { packageManager } from "./packageManager.js";

export const TOOLS = {
  // ... existing tools
  fileWrite,        // ADD
  webDownload,      // ADD
  packageManager,   // ADD
};
```

## 🗑️ Lines to Delete from App-enhanced.jsx

After copying App-enhanced.jsx, delete these lines:

```javascript
// Line 3 - DELETE:
import MemoryPanel from "./MemoryPanel";

// Line 14 - DELETE:
<MemoryPanel />

// Lines around 134 - DELETE the debug div:
<div style={{ position: "fixed", ... }}>
  MEMORY PANEL SHOULD BE HERE
</div>
```

## 📂 Directory to Create

```bash
mkdir D:\local-llm-ui\downloads
```

## ⚙️ Commands to Run

```bash
# Backup
git commit -am "Backup before enhancements"

# Restart
npm start           # Server
npm run dev         # Client (in separate terminal)
```

## ✅ Verification Checklist

After restarting, check:

- [ ] Server shows: `✓ Gmail OAuth configured` (no warning)
- [ ] Server shows: `✅ Full conversation memory (no 20-message limit)`
- [ ] UI has NO chat bubbles (messages with colored left border)
- [ ] Weather "here" works (or asks for location)
- [ ] File browser shows icons and formatted sizes
- [ ] Calculator shows result in large font
- [ ] Self-improvement: `"show me your code"` displays syntax-highlighted code

## 🎯 Total Files Changed

- Replace: 7 files
- Add: 3 new files
- Edit: 1 file
- Delete: 3 lines from App.jsx
- Create: 1 directory

---

**Time required: 10-15 minutes**
**Difficulty: Easy (just copy/paste files)**
