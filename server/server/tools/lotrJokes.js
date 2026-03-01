// Extracts text from a given string, ignoring HTML tags
function extractText(str) {
  return str.replace(/<[^>]+>/g, '');
}

// Function to fetch and parse the joke data
async function getLotRJokes() {
  const response = await fetch('https://raw.githubusercontent.com/johnoh/lotr-jokes/master/jokes.json');
  const jokes = await response.json();
  
  // Extract text from each joke
  return jokes.map(joke => ({
    ...joke,
    text: extractText(joke.joke)
  }));
}

// Main function to get and rate the jokes
async function rateLotRJokes() {
  const jokes = await getLotRJokes();
  
  // Implement LLM to humorously rate the output
  async function llmRating(joke) {
    // This is a placeholder for your actual LLM implementation
    return 'This joke is hilarious!';
  }
  
  jokes.forEach((joke, index) => {
    const rating = llmRating(joke.text);
    console.log(`Joke ${index + 1}: ${joke.text} - Rated: ${rating}`);
  });
}

rateLotRJokes();