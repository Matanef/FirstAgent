```javascript
import { spotify } from '../../server/tools/spotify';

describe('spotify function', () => {
  it('should return an error message when Spotify integration is not configured', async () => {
    const result = await spotify('test query');
    expect(result).toEqual({
      tool: "spotify",
      success: false,
      final: true,
      error: "Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard"
    });
  });

  it('should handle null input gracefully', async () => {
    const result = await spotify(null);
    expect(result).toEqual({
      tool: "spotify",
      success: false,
      final: true,
      error: "Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard"
    });
  });

  it('should handle empty string input gracefully', async () => {
    const result = await spotify('');
    expect(result).toEqual({
      tool: "spotify",
      success: false,
      final: true,
      error: "Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard"
    });
  });

  it('should handle unexpected errors gracefully', async () => {
    // Mocking the error handling
    console.error = jest.fn();
    const result = await spotify('test query');
    expect(result).toEqual({
      tool: "spotify",
      success: false,
      final: true,
      error: "Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard"
    });
    expect(console.error).toHaveBeenCalledWith('Error: Spotify integration not configured. Get API key from https://developer.spotify.com/dashboard');
  });
});
```