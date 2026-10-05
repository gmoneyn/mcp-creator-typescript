/**
 * creator_profile — Persistent user profile at ~/.mcp-creator-typescript/profile.json.
 * Tracks setup state, npm username, and project history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROFILE_DIR = join(homedir(), ".mcp-creator-typescript");
const PROFILE_FILE = join(PROFILE_DIR, "profile.json");

interface Project {
  name: string;
  npmUrl?: string;
  githubUrl?: string;
  description?: string;
}

interface Profile {
  setupComplete: boolean;
  npmUsername: string | null;
  githubUsername: string | null;
  defaultOutputDir: string | null;
  projects: Project[];
}

function loadProfile(): Profile {
  const defaults: Profile = {
    setupComplete: false,
    npmUsername: null,
    githubUsername: null,
    defaultOutputDir: null,
    projects: [],
  };

  if (!existsSync(PROFILE_FILE)) return defaults;

  try {
    const raw = readFileSync(PROFILE_FILE, "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveProfile(profile: Profile): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), "utf-8");
}

export async function getCreatorProfile(): Promise<string> {
  const profile = loadProfile();

  return JSON.stringify({
    profile,
    profilePath: PROFILE_FILE,
    nextSteps: profile.setupComplete
      ? ["Profile loaded. Ready to scaffold a new server with scaffold_server."]
      : ["Run check_setup to verify your environment, then update_creator_profile to save your info."],
  }, null, 2);
}

export async function updateCreatorProfile(
  setupComplete?: boolean,
  npmUsername?: string,
  githubUsername?: string,
  defaultOutputDir?: string,
  addProject?: string
): Promise<string> {
  const profile = loadProfile();

  if (setupComplete !== undefined) profile.setupComplete = setupComplete;
  if (npmUsername !== undefined) profile.npmUsername = npmUsername;
  if (githubUsername !== undefined) profile.githubUsername = githubUsername;
  if (defaultOutputDir !== undefined) profile.defaultOutputDir = defaultOutputDir;

  if (addProject) {
    try {
      const project = JSON.parse(addProject) as Project;
      const exists = profile.projects.some(p => p.name === project.name);
      if (!exists) {
        profile.projects.push(project);
      }
    } catch {
      return JSON.stringify({ error: "addProject must be a valid JSON string with at least a 'name' field." });
    }
  }

  saveProfile(profile);

  return JSON.stringify({
    success: true,
    profile,
    profilePath: PROFILE_FILE,
  }, null, 2);
}
