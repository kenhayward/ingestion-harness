import { useEffect, useMemo, useState, type CSSProperties } from 'react';
// Types only: the API checked the document against the contract (defaults filled) before
// sending it, and the contract's runtime (node:crypto signing) has no place in the browser.
import type { DecomposedDocument, Section } from '@ih/bridge-contract';
import type { ConversionReview } from '@ih/shared';
import { ApiError, type Api } from '../../api/client.js';
import { PageViewer } from '../../review/PageViewer.js';
import { Icon } from '../../ui/Icon.js';
import { StatusPill } from '../../ui/StatusPill.js';
import { navigate } from '../../router.js';
import { OUTCOME } from '../outcomes.js';
import { BlockView, Flags, FlagList, PageButton, type DocumentView } from './BlockView.js';
import { headingOf, OutlineTree } from './OutlineTree.js';
import { documentPages, flagCounts, flagsByElement } from './pages.js';
import { ReviewDecision } from './ReviewDecision.js';

/** The review GET's and the decisions' answer once the item is no longer awaiting review. */
const isNotAwaiting = (err: unknown) => err instanceof ApiError && err.status === 409;

/**
 * A held PDF's review page (`#/conversion/items/<itemId>/review`, spec §14.5): the page images
 * on the left, the decomposed document as it would be delivered on the right (its heading
 * outline, each section's blocks, each flag beside the element it is on), and Approve or Reject
 * below. Choosing a heading, block or flag shows its first page. Read-only.
 */
export function ConversionReviewPage({ api, itemId }: { api: Api; itemId: string }) {
  const [review, setReview] = useState<ConversionReview | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; notAwaiting: boolean } | null>(
    null,
  );
  const [target, setTarget] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.conversionReview(itemId).then(
      (r) => {
        if (!live) return;
        setReview(r);
        // The target is shown when it can be read; the review does not wait for it.
        Promise.all([api.getConversionBatch(r.item.batchId), api.listConversionTargets()]).then(
          ([detail, targets]) => {
            const id = detail.batch.targetId;
            if (live) setTarget(targets.find((t) => t.id === id)?.label ?? id);
          },
          () => {},
        );
      },
      (err: unknown) => {
        if (live) {
          setLoadError({ message: (err as Error).message, notAwaiting: isNotAwaiting(err) });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api, itemId]);

  const document = review?.document as unknown as DecomposedDocument | undefined;
  const pages = useMemo(
    () => (document && review ? documentPages(document, review.pageMap) : null),
    [document, review],
  );
  const flags = useMemo(
    () => (document && pages ? flagsByElement(document.report, pages) : new Map()),
    [document, pages],
  );

  if (loadError) {
    return (
      <div className="conversion-page">
        <a className="back-link" href="#/conversion">
          <Icon name="chevronLeft" />
          Conversion
        </a>
        <p role="alert">
          {loadError.notAwaiting
            ? 'This document is no longer awaiting review.'
            : `Could not load the review: ${loadError.message}`}
        </p>
      </div>
    );
  }
  if (!review || !document || !pages) return <p>Loading review…</p>;

  const { item, pageCount } = review;
  const batchHref = `#/conversion/${encodeURIComponent(item.batchId)}`;
  const imageIndex = new Map(review.images.map((image, i) => [image.id, i]));
  const imageAlt = new Map(document.images.map((image) => [image.id, image.alt]));
  const equations = new Map(document.equations.map((e) => [e.id, e]));
  const noteNumbers = new Map(document.notes.map((note, i) => [note.id, i + 1]));
  const flaggedPages = new Set(document.report.flatMap((flag) => pages.pagesOf(flag.at)));
  const looseFlags = flags.get(null) ?? [];

  const show = (id: string) => {
    setSelected(id);
    const first = pages.firstPage(id);
    if (first) setPage(Math.min(first, Math.max(1, pageCount)));
    window.document.getElementById(`dd-${id}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const view: DocumentView = {
    imageUrl: (id) => {
      const index = imageIndex.get(id);
      return index === undefined ? null : api.conversionImageUrl(item.id, index);
    },
    imageAlt: (id) => imageAlt.get(id) ?? null,
    equation: (id) => equations.get(id) ?? null,
    noteNumber: (id) => noteNumbers.get(id) ?? null,
    flagsOn: (id) => flags.get(id) ?? [],
    firstPage: pages.firstPage,
    onShow: show,
    selected,
  };

  const decide = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setDecisionError(null);
    try {
      await action();
      navigate(batchHref);
    } catch (err) {
      if (isNotAwaiting(err)) setDecided(true);
      else setDecisionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sectionView = (section: Section, depth: number) => {
    const Heading = `h${Math.min(depth + 2, 6)}` as 'h2';
    return (
      <section key={section.id} id={`dd-${section.id}`} className="dd-section">
        <div className={`dd-heading${selected === section.id ? ' selected' : ''}`}>
          <Heading>{headingOf(section)}</Heading>
          <PageButton id={section.id} view={view} />
        </div>
        <FlagList id={section.id} view={view} />
        {section.blocks.map((block) => (
          <BlockView key={block.id} block={block} view={view} />
        ))}
        {section.sections.map((sub) => sectionView(sub, depth + 1))}
      </section>
    );
  };

  const counts = flagCounts(document.report);
  const meta = [target, `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="review conversion-review">
      <header className="review-header">
        <a className="back-link" href={batchHref}>
          <Icon name="chevronLeft" />
          Conversion
        </a>
        <span className="review-header-rule" aria-hidden="true" />
        <h1 title={item.sourceKey}>{item.filename}</h1>
        <StatusPill {...OUTCOME[item.outcome]} />
        <span className="review-meta muted" title={meta}>
          {meta}
        </span>
        {counts.length > 0 && (
          <ul className="flag-counts" aria-label="Flags by kind">
            {counts.map(([code, n]) => (
              <li key={code}>
                <span className="flag-chip">
                  <Icon name="flag" />
                  <span className="mono">{code}</span> {n}
                </span>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div className="review-workspace doc-left" style={{ '--doc-width': '45%' } as CSSProperties}>
        <PageViewer
          src={api.conversionPageUrl(item.id, page)}
          thumbSrc={(n) => api.conversionPageUrl(item.id, n)}
          page={page}
          pageCount={Math.max(1, pageCount)}
          flaggedPages={flaggedPages}
          onPage={setPage}
        />
        <section className="review-data" aria-label="Decomposed document">
          <div className="data-head">
            <span className="eyebrow">Decomposed document</span>
            <span className="muted">
              {document.sections.length} {document.sections.length === 1 ? 'section' : 'sections'}
              {document.report.length > 0 && ` · ${document.report.length} flagged`}
            </span>
          </div>
          <div className="data-body">
            <div className="data-outline">
              <OutlineTree
                sections={document.sections}
                flagCount={(id) => view.flagsOn(id).length}
                selected={selected}
                onShow={show}
              />
            </div>
            <div className="data-view">
              <div className="dd-document">
                {looseFlags.length > 0 && <Flags flags={looseFlags} />}
                {document.blocks.map((block) => (
                  <BlockView key={block.id} block={block} view={view} />
                ))}
                {document.sections.map((section) => sectionView(section, 0))}
                {document.notes.length > 0 && (
                  <section className="dd-section dd-notes">
                    <h2>Notes</h2>
                    <ol>
                      {document.notes.map((note) => (
                        <li key={note.id} id={`dd-${note.id}`}>
                          <FlagList id={note.id} view={view} />
                          {note.blocks.map((block) => (
                            <BlockView key={block.id} block={block} view={view} nested />
                          ))}
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <ReviewDecision
        busy={busy}
        error={decisionError}
        decided={decided}
        batchHref={batchHref}
        onApprove={(note) => void decide(() => api.approveConversionItem(item.id, note))}
        onReject={(note) => void decide(() => api.rejectConversionItem(item.id, note))}
      />
    </div>
  );
}
