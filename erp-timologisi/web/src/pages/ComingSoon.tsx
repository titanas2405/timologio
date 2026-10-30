import { PageHeader } from "../ui";

export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card empty">
        <span className="soon">Σύντομα</span>
        <p>{description}</p>
      </div>
    </>
  );
}
