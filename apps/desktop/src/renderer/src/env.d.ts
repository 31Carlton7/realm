/// <reference types="vite/client" />
interface Window { realm: { port: number; home: string; pickFolder(): Promise<string | null> } }
