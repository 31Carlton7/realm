"use client"

import { useEffect, useState } from "react"

import styles from "./docs.module.css"

/** Copy a code block's text. It says Copied for a moment where it said Copy, and nothing else moves. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={styles.copy}
      aria-live="polite"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}
