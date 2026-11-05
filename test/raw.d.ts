// Vite ?raw imports (used by tests to read text files).
declare module "*?raw" {
  const content: string;
  export default content;
}
