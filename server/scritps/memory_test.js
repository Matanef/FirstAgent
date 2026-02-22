// server/scripts/memory_test.js
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

import { getProfile, setProfileField, addOrUpdateContact, listContacts, deleteContact } from "../memory.js";

(async () => {
  try {
    console.log("=== MEMORY TEST START ===");
    const before = await getProfile();
    console.log("Profile before:", JSON.stringify(before, null, 2));

    console.log("Setting self.tone = 'test-tone'");
    await setProfileField("self.tone", "test-tone");
    console.log("Profile after tone set:", JSON.stringify(await getProfile(), null, 2));

    console.log("Adding contact 'Test User'");
    await addOrUpdateContact("test_user", { name: "Test User", email: "test@example.com" });
    console.log("Contacts now:", JSON.stringify(await listContacts(), null, 2));

    console.log("Deleting contact 'test_user'");
    const deleted = await deleteContact("test_user");
    console.log("Deleted:", deleted);
    console.log("Contacts after delete:", JSON.stringify(await listContacts(), null, 2));

    console.log("Cleaning up: removing test tone");
    await setProfileField("self.tone", undefined);
    console.log("Profile final:", JSON.stringify(await getProfile(), null, 2));

    console.log("=== MEMORY TEST COMPLETE ===");
    process.exit(0);
  } catch (err) {
    console.error("Memory test failed:", err);
    process.exit(1);
  }
})();