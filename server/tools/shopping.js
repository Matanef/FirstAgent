// server/tools/shopping.js

export async function shopping(query) {
  return {
    tool: "shopping",
    success: true,
    final: true,
    data: {
      text:
        "Shopping tool placeholder. No real shopping API is configured yet. " +
        "You can extend this to call Amazon, eBay, or other providers.",
      query
    }
  };
}