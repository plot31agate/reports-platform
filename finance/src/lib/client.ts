/* client.ts — the business this Finance HQ instance runs for.

   One place for the name, currency and tax framing so every view and every
   Claude prompt speaks in the right units. Finance HQ is INTERNAL (DF's own
   numbers), so unlike the client portal there is one business here, not a
   roster — but the shape stays simple to change. */

export interface BusinessConfig {
  id: string;
  name: string;
  legalName: string;
  domain: string;
  /** ISO 4217 code, used for Intl.NumberFormat. */
  currency: string;
  /** BCP-47 locale for money/date formatting. */
  locale: string;
  /** Tax jurisdiction — steers the tax-liability framing in prompts. */
  jurisdiction: string;
  /** Month the financial year starts (1–12). UK default: April. */
  fyStartMonth: number;
}

export const BUSINESS: BusinessConfig = {
  id: 'df',
  name: 'Digital Footprints',
  legalName: 'Digital Footprints Ltd',
  domain: 'digitalfootprints.co.uk',
  currency: 'GBP',
  locale: 'en-GB',
  jurisdiction: 'United Kingdom',
  fyStartMonth: 4,
};
