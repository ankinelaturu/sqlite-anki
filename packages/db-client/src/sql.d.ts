// Vite `?raw` imports (e.g. the bundled demo schema) resolve to a string.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
