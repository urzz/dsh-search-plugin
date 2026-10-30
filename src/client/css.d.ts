/** Stylesheets are loaded as text and owned by the plugin lifecycle. */
declare module '*.css' { const text: string; export default text }
