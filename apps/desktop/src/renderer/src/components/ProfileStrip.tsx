import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { useState } from "react";

export function ProfileStrip() {
  const profiles = useApp((s) => s.profiles);
  const active = useApp((s) => s.activeProfileId);
  const selectProfile = useApp((s) => s.selectProfile);
  const createProfile = useApp((s) => s.createProfile);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="profile-strip">
      {profiles.map((p) => (
        <button key={p.id} className={"profile-dot" + (p.id === active ? " active" : "")} title={p.name} aria-label={p.name}
          style={{ ["--dot" as string]: p.color }} onClick={() => void selectProfile(p.id)}>
          <Icon name={p.icon} size={14} />
        </button>
      ))}
      {adding ? (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void createProfile(name.trim()); setName(""); setAdding(false); }}>
          <input autoFocus placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setAdding(false)} />
        </form>
      ) : (
        <button className="profile-dot ghost" aria-label="Add profile" title="Add profile" onClick={() => setAdding(true)}><Icon name="add" size={14} /></button>
      )}
    </div>
  );
}
