import { loadProviders } from "./providers/_registry.mjs";
import { makeHttpCtx } from "./providers/_http.mjs";

const brands = [
  { name: "Marriott International", careers_url: "https://careers.marriott.com" },
  { name: "Hilton Worldwide", careers_url: "https://jobs.hilton.com" },
  { name: "Hyatt Hotels", careers_url: "https://careers.hyatt.com" },
  { name: "IHG Hotels & Resorts", careers_url: "https://careers.ihg.com" },
  { name: "Drury Hotels", careers_url: "https://careers.druryhotels.com" },
  { name: "Vail Resorts", careers_url: "https://jobs.vailresorts.com" },
];

const providers = await loadProviders(new URL("./providers/", import.meta.url).pathname);
const ctx = makeHttpCtx();
const phenom = providers.get("phenom");
for (const b of brands) {
  try {
    const jobs = await phenom.fetch({ ...b, provider: "phenom" }, ctx);
    const n = Array.isArray(jobs) ? jobs.length : "ERR";
    console.log(`${b.name}: phenom returned ${n} jobs`);
    if (Array.isArray(jobs) && jobs.length) {
      console.log("   sample:", jobs[0].title, "|", jobs[0].location, "|", jobs[0].url.slice(0, 90));
    }
  } catch (e) {
    console.log(b.name, "phenom fetch threw:", e.message);
  }
}
