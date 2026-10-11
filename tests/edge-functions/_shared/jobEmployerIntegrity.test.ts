import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { jobEmployerIdentityConflict } from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";

const employer = (name: string, url = "https://www.linkedin.com/company/acme") => ({
  id: 42, name, linkedinUrl: url,
});
const job = (descriptionText: string, company = employer("Acme")) => ({
  id: 7, title: "Sales Manager", company, descriptionText,
  linkedinUrl: "https://www.linkedin.com/jobs/view/7",
});

Deno.test("a posting whose explicit employer is the structured company can prove hiring", () => {
  assertEquals(jobEmployerIdentityConflict(job("← All jobs\nSales Manager\nAcme, Inc.\nBoston, MA\nPosted 2d ago")), null);
});

Deno.test("a posting naming a different employer cannot prove Acme hiring", () => {
  assertEquals(jobEmployerIdentityConflict(job("← All jobs\nSales Manager\nOtherCo\nBoston, MA\nPosted 2d ago")), "posting_employer_conflict");
  assertEquals(jobEmployerIdentityConflict(job("← All jobs\nSales Manager\nChampions Club Texas\nDallas, TX\nPosted 6d ago\nAbout Champions Social Club")), "posting_employer_conflict");
});

Deno.test("a body with no explicit employer preserves existing behavior", () => {
  assertEquals(jobEmployerIdentityConflict(job("Sell our software to customers in Boston.")), null);
  assertEquals(jobEmployerIdentityConflict(job("← All jobs\nSales Manager\nBoston, MA\nPosted 2d ago")), null);
});

Deno.test("conflicting structured LinkedIn company identities require resolution", () => {
  assertEquals(jobEmployerIdentityConflict({
    ...job("Sell our software to customers."),
    companyLinkedinUrl: "https://www.linkedin.com/company/otherco",
  }), "structured_employer_conflict");
});

Deno.test("legal suffix and punctuation variations do not conflict", () => {
  for (const name of ["Acme", "Acme, Inc.", "Acme Inc"]) {
    assertEquals(jobEmployerIdentityConflict(job(`← All jobs\nSales Manager\n${name}\nBoston, MA\nPosted 2d ago`)), null);
  }
});
