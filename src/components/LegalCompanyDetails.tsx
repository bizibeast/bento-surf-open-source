export function LegalCompanyDetails() {
  return (
    <section
      aria-labelledby="legal-company-details-title"
      className="mt-5 rounded-[30px] border border-white/80 bg-white/85 p-7 shadow-[0_22px_60px_-42px_rgba(23,33,58,0.42)]"
    >
      <h2 id="legal-company-details-title" className="font-display text-2xl">
        Company details
      </h2>
      <dl className="mt-4 grid gap-6 text-sm leading-6 text-[#17213a]/68 sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-[#17213a]">Legal Name</dt>
          <dd className="mt-1">Palshri Private Limited</dd>
        </div>
        <div>
          <dt className="font-semibold text-[#17213a]">CIN</dt>
          <dd className="mt-1 break-words">U92419MH2023PTC397301</dd>
        </div>
        <div>
          <dt className="font-semibold text-[#17213a]">GSTIN</dt>
          <dd className="mt-1 break-words">27AANCP5244P1ZN</dd>
        </div>
        <div>
          <dt className="font-semibold text-[#17213a]">Address</dt>
          <dd className="mt-1">
            <address className="not-italic">
              A 505, Sai Bhavatarini Ashray
              <br />
              Titwala East – 421605
              <br />
              Maharashtra, India
            </address>
          </dd>
        </div>
      </dl>
    </section>
  );
}
