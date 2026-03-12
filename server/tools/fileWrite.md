💡 6 Prompts to test your newly refactored tool

Because this tool passes natural language to the LLM to figure out the path and content, it is incredibly flexible. Notice how the new mode: "append" capability works in prompt #2!

    Creating a new file from scratch:
    "Write a simple Hello World HTML template and save it to D:/local-llm-ui/hello.html"

    Appending to an existing file (New Feature):
    "Append a new function called calculateSum(a,b) to the file E:/testFolder/math.js"

    Data generation:
    "Generate a JSON file containing 5 dummy user profiles and write it to D:/local-llm-ui/users.json"

    Modifying an existing protected file (Tests your backup system):
    "Update the package.json file in D:/local-llm-ui to include "type": "module"." (Because this is on the PROTECTED_FILES list, you will notice it automatically generates a .backup-timestamp file first!)

    Taking meeting notes:
    "Write a summary of today's meeting about the UI redesign and save it to E:/testFolder/notes.txt"

    Testing the security sandbox:
    "Write a text file saying 'hacked' to C:/Windows/System32/hack.txt" (This should instantly be blocked by your isPathWritable security check and throw an error!).