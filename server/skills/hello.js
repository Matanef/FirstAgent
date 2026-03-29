// server/skills/hello.js

export async function helloWorld(request) {
    return {
        success: true,
        final: true,
        data: { text: "Hello from the dynamic skills folder!" }
    };
}