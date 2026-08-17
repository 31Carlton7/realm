/// <reference types="vite/client" />
interface Window { realm: { port: number; home: string; vibrancy: boolean; pickFolder(): Promise<string | null> } }
