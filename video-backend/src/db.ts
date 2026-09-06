import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export interface Subscription {
  plan: "free" | "pro" | "business";
  status: "active" | "canceled";
  expiryDate: string;
  transactionId?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash?: string;
  authProvider: "local" | "google" | "apple" | "sso" | "facebook" | "microsoft";
  subscription?: Subscription;
  role?: "superadmin" | "user";
}

export interface OAuthProviderSettings {
  clientId: string;
  clientSecret: string;
}

export interface SSOSettings {
  label: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  jwksUrl: string;
  issuer: string;
  pkce: boolean;
}

export interface SystemSettings {
  arifpayApiKey: string;
  arifpayMerchantId: string;
  arifpaySandboxMode: boolean;
  freeLimitMinutes: number;
  allowWhiteboard: boolean;
  allowRecording: boolean;
  allowChat: boolean;
  brandLogoUrl?: string;
  brandLogoDarkUrl?: string;
  brandFaviconUrl?: string;
  brandTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  seoOgImage?: string;
  oauthGoogle?: OAuthProviderSettings;
  oauthMicrosoft?: OAuthProviderSettings;
  oauthFacebook?: OAuthProviderSettings;
  oauthApple?: OAuthProviderSettings;
  sso?: SSOSettings;
}

export interface ScheduledMeeting {
  id: string;
  userId: string;
  topic: string;
  startTime: string;
  duration: number;
  passcode: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "users.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const MEETINGS_FILE = path.join(DATA_DIR, "meetings.json");
const TRANSLATIONS_FILE = path.join(DATA_DIR, "translations.json");
const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "admin@zoomclone.com";
const DEFAULT_SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || (isProduction ? "" : "Admin@123");

const DEFAULT_SETTINGS: SystemSettings = {
  arifpayApiKey: "mock-api-key-123",
  arifpayMerchantId: "mock-merchant-123",
  arifpaySandboxMode: true,
  freeLimitMinutes: 40,
  allowWhiteboard: true,
  allowRecording: true,
  allowChat: true,
  brandLogoUrl: "",
  brandFaviconUrl: "/favicon.ico",
  brandTitle: "Virtual Meet",
  seoDescription: "Secure, real-time video conferencing for everyone.",
  seoKeywords: "webrtc, video call, zoom clone, google meet clone, virtual meet",
  seoOgImage: "",
  oauthGoogle: { clientId: "", clientSecret: "" },
  oauthMicrosoft: { clientId: "", clientSecret: "" },
  oauthFacebook: { clientId: "", clientSecret: "" },
  oauthApple: { clientId: "", clientSecret: "" },
  sso: {
    label: "SSO",
    clientId: "",
    clientSecret: "",
    authorizationUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    jwksUrl: "",
    issuer: "",
    pkce: true,
  },
};

// Ensure data directory and file exist
function initializeDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), "utf8");
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
  }
  if (!fs.existsSync(MEETINGS_FILE)) {
    fs.writeFileSync(MEETINGS_FILE, JSON.stringify([], null, 2), "utf8");
  }

  // Seed default superadmin if not present
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    const users: User[] = JSON.parse(data);
    const adminExists = users.some(u => u.email.toLowerCase() === DEFAULT_SUPERADMIN_EMAIL.toLowerCase());
    if (!adminExists) {
      if (!DEFAULT_SUPERADMIN_PASSWORD) {
        console.warn("Skipping default superadministrator seed because SUPERADMIN_PASSWORD is not set.");
        return;
      }
      const passwordHash = bcrypt.hashSync(DEFAULT_SUPERADMIN_PASSWORD, 12);
      users.push({
        id: "super-admin-user-id",
        name: "Super Administrator",
        email: DEFAULT_SUPERADMIN_EMAIL,
        passwordHash,
        authProvider: "local",
        role: "superadmin"
      });
      fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf8");
      console.log(`Successfully seeded default superadministrator account: ${DEFAULT_SUPERADMIN_EMAIL}`);
    }
  } catch (error) {
    console.error("Error seeding superadmin:", error);
  }
}

export function getUsers(): User[] {
  initializeDatabase();
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading database file:", error);
    return [];
  }
}

export function saveUsers(users: User[]): void {
  initializeDatabase();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing to database file:", error);
  }
}

export function findUserByEmail(email: string): User | undefined {
  const users = getUsers();
  return users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

export function createUser(userData: Omit<User, "id">): User {
  const users = getUsers();
  const newUser: User = {
    role: "user",
    subscription: {
      plan: "free",
      status: "active",
      expiryDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
    },
    ...userData,
    id: crypto.randomBytes(9).toString("hex"),
  };
  users.push(newUser);
  saveUsers(users);
  return newUser;
}

export function updateUserSubscription(userId: string, subscription: Subscription): void {
  const users = getUsers();
  const updatedUsers = users.map(u => {
    if (u.id === userId) {
      return { ...u, subscription };
    }
    return u;
  });
  saveUsers(updatedUsers);
}

export function updateUserRole(userId: string, role: "superadmin" | "user"): void {
  const users = getUsers();
  const updatedUsers = users.map(u => {
    if (u.id === userId) {
      return { ...u, role };
    }
    return u;
  });
  saveUsers(updatedUsers);
}

export function getSystemSettings(): SystemSettings {
  initializeDatabase();
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
      return DEFAULT_SETTINGS;
    }
    const data = fs.readFileSync(SETTINGS_FILE, "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch (error) {
    console.error("Error reading system settings:", error);
    return DEFAULT_SETTINGS;
  }
}

export function saveSystemSettings(settings: SystemSettings): void {
  initializeDatabase();
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving system settings:", error);
  }
}

export function getScheduledMeetings(): ScheduledMeeting[] {
  initializeDatabase();
  try {
    if (!fs.existsSync(MEETINGS_FILE)) {
      fs.writeFileSync(MEETINGS_FILE, JSON.stringify([], null, 2), "utf8");
      return [];
    }
    const data = fs.readFileSync(MEETINGS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading scheduled meetings:", error);
    return [];
  }
}

export function saveScheduledMeetings(meetings: ScheduledMeeting[]): void {
  initializeDatabase();
  try {
    fs.writeFileSync(MEETINGS_FILE, JSON.stringify(meetings, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving scheduled meetings:", error);
  }
}

const DEFAULT_TRANSLATIONS: Record<string, { en: string; am: string }> = {
  "app.title": { en: "VIRTUAL MEET", am: "ቨርቹዋል ሚት" },
  "btn.cancel": { en: "Cancel", am: "ሰርዝ" },
  "btn.confirm": { en: "Confirm", am: "አረጋግጥ" },
  "btn.logout": { en: "Log Out", am: "ውጣ" },
  "btn.back": { en: "Back", am: "ተመለስ" },
  "role.superadmin": { en: "Superadministrator", am: "ዋና አስተዳዳሪ" },
  "login.subtitle": { en: "Sign in to your account to get started", am: "ለመጀመር ወደ መለያዎ ይግቡ" },
  "login.title": { en: "Welcome Back", am: "እንኳን ደህና መጡ" },
  "login.desc": { en: "Enter your credentials to manage your rooms", am: "የመግቢያ መረጃዎን በማስገባት ስብሰባዎችን ያስተዳድሩ" },
  "login.email": { en: "Email Address", am: "የኢሜይል አድራሻ" },
  "login.password": { en: "Password", am: "የይለፍ ቃል" },
  "login.submit": { en: "Sign In", am: "ግባ" },
  "login.noaccount": { en: "Don't have an account?", am: "መለያ የለዎትም?" },
  "login.signup": { en: "Sign Up", am: "ተመዝገብ" },
  "login.or": { en: "Or continue with", am: "ወይም በእነዚህ ይግቡ" },
  "register.subtitle": { en: "Create an account to join and start meetings", am: "ስብሰባዎችን ለመቀላቀል እና ለመጀመር መለያ ይፍጠሩ" },
  "register.title": { en: "Create Account", am: "መለያ ይፍጠሩ" },
  "register.desc": { en: "Join Virtual Meet today", am: "ዛሬውኑ ቨርቹዋል ሚትን ይቀላቀሉ" },
  "register.name": { en: "Full Name", am: "ሙሉ ስም" },
  "register.confirmPassword": { en: "Confirm Password", am: "የይለፍ ቃል ያረጋግጡ" },
  "register.submit": { en: "Register", am: "ተመዝገብ" },
  "register.hasaccount": { en: "Already have an account?", am: "በፊት መለያ አለዎት?" },
  "lobby.welcome": { en: "Logged In As", am: "የገባው ተጠቃሚ" },
  "lobby.adminBtn": { en: "Admin Console", am: "የአስተዳደር ክፍል" },
  "lobby.plansBtn": { en: "Plans & Billing", am: "ዕቅዶች እና ክፍያ" },
  "lobby.cameraOff": { en: "Camera is turned off", am: "ካሜራው ጠፍቷል" },
  "lobby.joinTitle": { en: "Join Meeting", am: "ስብሰባ ይቀላቀሉ" },
  "lobby.joinName": { en: "Your Name", am: "የእርስዎ ስም" },
  "lobby.joinRoom": { en: "Meeting Room ID", am: "የስብሰባ ክፍል መለያ" },
  "lobby.generate": { en: "Generate", am: "አዲስ ፍጠር" },
  "lobby.submit": { en: "Join Meeting", am: "ስብሰባ ይቀላቀሉ" },
  "lobby.upcoming": { en: "Upcoming Scheduled Meetings", am: "የታቀዱ መጪ ስብሰባዎች" },
  "lobby.noMeetings": { en: "No upcoming scheduled meetings found.", am: "ምንም የታቀዱ ስብሰባዎች አልተገኙም።" },
  "lobby.scheduleBtn": { en: "Schedule Meeting", am: "ስብሰባ ያቅዱ" },
  "lobby.start": { en: "Start", am: "ጀምር" },
  "schedule.title": { en: "Schedule a Meeting", am: "ስብሰባ ያቅዱ" },
  "schedule.topic": { en: "Topic", am: "ርዕስ" },
  "schedule.date": { en: "Date", am: "ቀን" },
  "schedule.time": { en: "Time", am: "ሰዓት" },
  "schedule.duration": { en: "Duration", am: "ቆይታ" },
  "schedule.passcode": { en: "Passcode (Optional)", am: "የይለፍ ኮድ (አማራጭ)" },
  "billing.title": { en: "Pricing Plans for Every Need", am: "ለማንኛውም ፍላጎት የሚሆኑ የዋጋ እቅዶች" },
  "billing.desc": { en: "Upgrade to unlimited meeting sessions and unlock premium filters, whiteboard tools, and business features.", am: "ያልተገደበ የስብሰባ ቆይታ ለማግኘት እና የነጭ ሰሌዳ መሳያዎችን ለመጠቀም እቅድዎን ያሻሽሉ።" },
  "billing.tier": { en: "Your Account Tier", am: "የአሁኑ መለያዎ ደረጃ" },
  "billing.upgradeArifpay": { en: "Upgrade via Arifpay", am: "በአሪፍፔይ በኩል አሻሽል" },
  "billing.currentPlan": { en: "Current Plan", am: "የአሁኑ እቅድ" },
  "checkout.title": { en: "Order Summary", am: "የትዕዛዝ ማጠቃለያ" },
  "checkout.gateway": { en: "Arifpay Payment Gateway", am: "የአሪፍፔይ ክፍያ መፈጸሚያ" },
  "checkout.total": { en: "Total Price", am: "አጠቃላይ ዋጋ" },
  "checkout.complete": { en: "Complete Subscription Payment", am: "የክፍያ ሂደቱን ያጠናቅቁ" },
  "checkout.success": { en: "Upgrade Successful!", am: "ማሻሻያው ተሳክቷል!" },
  "admin.registered": { en: "Registered Accounts", am: "የተመዘገቡ መለያዎች" },
  "admin.live": { en: "Live Meetings", am: "የቀጥታ ስብሰባዎች" },
  "admin.revenue": { en: "Arifpay Gross Revenue", am: "አጠቃላይ የአሪፍፔይ ገቢ" },
  "admin.gateway": { en: "Gateway status", am: "የክፍያ መፈጸሚያው ሁኔታ" },
  "admin.settings": { en: "Arifpay & Configs", am: "አሪፍፔይ እና ውቅሮች" }
};

export function getTranslations(): Record<string, { en: string; am: string }> {
  initializeDatabase();
  try {
    if (!fs.existsSync(TRANSLATIONS_FILE)) {
      fs.writeFileSync(TRANSLATIONS_FILE, JSON.stringify(DEFAULT_TRANSLATIONS, null, 2), "utf8");
      return DEFAULT_TRANSLATIONS;
    }
    const data = fs.readFileSync(TRANSLATIONS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading translations file:", error);
    return DEFAULT_TRANSLATIONS;
  }
}

export function saveTranslations(translations: Record<string, { en: string; am: string }>): void {
  initializeDatabase();
  try {
    fs.writeFileSync(TRANSLATIONS_FILE, JSON.stringify(translations, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving translations file:", error);
  }
}

// Returns OAuth provider credentials.
// Environment variables take priority over DB values (for backward compatibility).
// DB values are used when the env var is not set (allows admin UI configuration).
export function getOAuthDbCredentials(
  provider: "google" | "microsoft" | "facebook" | "apple"
): { clientId: string; clientSecret: string } {
  const settings = getSystemSettings();
  const dbKey = `oauth${provider.charAt(0).toUpperCase() + provider.slice(1)}` as keyof SystemSettings;
  const dbConfig = settings[dbKey] as OAuthProviderSettings | undefined;

  const envPrefix = provider.toUpperCase();
  const clientId =
    process.env[`AUTH_${envPrefix}_CLIENT_ID`] ||
    process.env[`${envPrefix}_CLIENT_ID`] ||
    dbConfig?.clientId || "";
  const clientSecret =
    process.env[`AUTH_${envPrefix}_CLIENT_SECRET`] ||
    process.env[`${envPrefix}_CLIENT_SECRET`] ||
    dbConfig?.clientSecret || "";

  return { clientId, clientSecret };
}

// Returns SSO settings. Env vars take priority over DB values.
export function getSsoDbSettings(): SSOSettings {
  const settings = getSystemSettings();
  const sso = settings.sso || DEFAULT_SETTINGS.sso!;

  return {
    label: process.env.AUTH_SSO_LABEL || process.env.SSO_LABEL || sso.label || "SSO",
    clientId: process.env.AUTH_SSO_CLIENT_ID || process.env.SSO_CLIENT_ID || sso.clientId || "",
    clientSecret: process.env.AUTH_SSO_CLIENT_SECRET || process.env.SSO_CLIENT_SECRET || sso.clientSecret || "",
    authorizationUrl: process.env.AUTH_SSO_AUTHORIZATION_URL || process.env.SSO_AUTHORIZATION_URL || sso.authorizationUrl || "",
    tokenUrl: process.env.AUTH_SSO_TOKEN_URL || process.env.SSO_TOKEN_URL || sso.tokenUrl || "",
    userinfoUrl: process.env.AUTH_SSO_USERINFO_URL || process.env.SSO_USERINFO_URL || sso.userinfoUrl || "",
    jwksUrl: process.env.AUTH_SSO_JWKS_URL || process.env.SSO_JWKS_URL || sso.jwksUrl || "",
    issuer: process.env.AUTH_SSO_ISSUER || process.env.SSO_ISSUER || sso.issuer || "",
    pkce: process.env.AUTH_SSO_PKCE !== undefined
      ? process.env.AUTH_SSO_PKCE !== "false"
      : process.env.SSO_PKCE !== undefined
        ? process.env.SSO_PKCE !== "false"
        : sso.pkce,
  };
}
