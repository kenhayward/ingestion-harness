/** Help topics for the Workbench project tabs (one per tab; `WB_TAB_HELP` in ProjectPage). */

function Proposals() {
  return (
    <>
      <h3>Proposals</h3>
      <p>
        The model's answer arrives as a proposal card listing each change with its reason. Tick the
        changes you want and <strong>Apply</strong> them to the draft, or <strong>Reject</strong>{' '}
        the proposal; nothing reaches the draft until you apply it. A proposal that changes nothing
        is accepted with <strong>Accept: no changes needed</strong>. Running the stage again makes a
        new proposal.
      </p>
      <h3>Out of date</h3>
      <p>
        When an earlier stage changes after this one was completed, this stage is marked out of
        date: run it again, or <strong>Keep</strong> what you have if the change does not affect it.
      </p>
    </>
  );
}

export function WbOverviewHelp() {
  return (
    <>
      <p>
        Where the project stands at a glance: every stage of building the document type, laid out in
        the order you work through them.
      </p>
      <h3>Next</h3>
      <p>
        The banner at the top names the next thing to do and links to it. Optional stages
        (References, Evaluate, Revise) are never the next thing on their own, but after a revision
        it suggests evaluating the new draft.
      </p>
      <h3>The map</h3>
      <p>
        Each box is a tab: its state (done, waiting for your decision, out of date, running, not
        started) and two figures, such as samples prepared or the latest score. Click a box to open
        the tab.
      </p>
      <h3>The header</h3>
      <p>
        Above every tab: the data policy (local, or external models allowed, which only an
        administrator can switch on) and <strong>Publish vN</strong>, which goes to the Recipe tab.
      </p>
      <h3>Reset project</h3>
      <p>
        <strong>Reset project…</strong> starts the recipe again from scratch: proposals, runs,
        references, evaluations and feedback go, and the draft becomes empty. The samples, the
        brief's written answers and the settings stay. It asks you to type the project's id first.
      </p>
    </>
  );
}

export function WbSamplesHelp() {
  return (
    <>
      <p>
        Samples are real documents of this type that the recipe is built and tested on. Add PDF or
        Word files here; each is prepared (its text read, scanned pages through OCR), with progress
        and its page count as it goes.
      </p>
      <h3>Dev and holdout</h3>
      <ul>
        <li>
          <strong>Dev</strong> samples are what the drafting model reads and what you test on while
          building.
        </li>
        <li>
          <strong>Holdout</strong> samples are kept back: never shown to the drafting model, they
          measure the finished recipe fairly before publishing (Evaluate).
        </li>
      </ul>
      <p>
        Keep a few varied dev samples and a few holdout ones; change a sample's role from its row.
      </p>
      <h3>Reading a sample</h3>
      <p>
        Open a sample to read its prepared text page by page (← and → move between pages). A sample
        that could not be prepared says why.
      </p>
    </>
  );
}

export function WbBriefHelp() {
  return (
    <>
      <p>
        The brief tells the drafting model what you need: what the documents are, what to extract,
        and anything it should know. Every drafting stage reads it, so time spent here pays off.
      </p>
      <h3>Sections of the brief</h3>
      <p>
        Fill in the sections that apply; answers to the Survey's questions land here too. Unsaved
        edits are kept in this browser if you leave the tab.
      </p>
      <h3>Versions</h3>
      <p>
        Each save makes a new version of the brief. The history shows which sections changed and
        which stages used each version, and two versions can be compared. Stages proposed from an
        older brief are not marked out of date by a new one; run them again if the change matters.
      </p>
      <h3>Ontologies</h3>
      <p>
        The vocabularies for linked data are picked on the Survey tab; the brief shows a summary.
      </p>
    </>
  );
}

export function WbSurveyHelp() {
  return (
    <>
      <p>
        The first drafting stage: the model reads the dev samples and the brief and reports what it
        sees, before anything is built.
      </p>
      <ul>
        <li>
          <strong>Findings</strong>: a summary, the variants it noticed between samples, and the
          document's anatomy (its parts in order).
        </li>
        <li>
          <strong>Questions</strong>: what it could not tell; your answers go into the brief.
        </li>
        <li>
          <strong>Candidates</strong>: outputs it suggests, with the samples they were seen in, and
          whether the brief already asks for them.
        </li>
        <li>
          <strong>Ontologies</strong>: library vocabularies that cover the candidates, with the
          evidence. <strong>Pin</strong> one to use it for mapping; nothing is pinned without a
          click. Refresh the suggestions when the library has changed.
        </li>
      </ul>
      <p>Accept the survey to move on, or reject it and run it again with a better brief.</p>
    </>
  );
}

export function WbOutputsHelp() {
  return (
    <>
      <p>
        The model proposes the recipe's outputs, the fields and tables to extract, from the survey,
        the brief and the samples. The tab compares the draft's outputs with the published
        version's.
      </p>
      <Proposals />
      <h3>Delivered outputs</h3>
      <p>
        The switches choose what publishing delivers: <strong>S3</strong> (CSV and JSON files) and{' '}
        <strong>RDF</strong> (linked data). Turning RDF off removes the ontology mapping after
        asking. One target always stays on.
      </p>
    </>
  );
}

export function WbSectionsHelp() {
  return (
    <>
      <p>
        The model proposes section anchors: where each part of the document starts. Every anchor is
        tried on every dev sample before you see it, and the model gets one round to fix those that
        miss.
      </p>
      <h3>Where each anchor lands</h3>
      <p>
        The grid shows, for every sample and section, the page and line the anchor matched and how
        much text it took. Click a cell to see it in the sample's text. Edit anchors and the grid
        updates as you type; for a required section that misses a sample, a suggested fix may be
        offered. Save to put the anchors in the draft.
      </p>
      <p>
        One fix is for a gap you cannot see: PDFs often put a no-break space where a plain one
        appears, as in <em>Table 13:</em>. An anchor with a plain space then misses, and the
        suggestion writes that space as <code>\s</code>, which matches either.
      </p>
      <h3>Repeating blocks</h3>
      <p>
        For blocks that repeat per batch or item, tick <strong>Repeats</strong> and give a key; the
        ? beside Anchors explains how they work together.
      </p>
      <Proposals />
    </>
  );
}

export function WbStepsHelp() {
  return (
    <>
      <p>
        The model proposes the pipeline, the recipe's extraction steps: which outputs each step
        fills, which sections it reads, and its instructions.
      </p>
      <h3>Coverage</h3>
      <p>
        The coverage strip shows which step fills each output; every output must be filled by
        exactly one step. Each step card shows how it did in recent runs (attempts, time) and warns
        when it often needs a retry.
      </p>
      <Proposals />
      <p>Edit steps by hand on the Recipe tab's Pipeline.</p>
    </>
  );
}

export function WbMappingHelp() {
  return (
    <>
      <p>
        For linked data: the model proposes how each output maps to terms of the pinned ontologies,
        with its confidence, the evidence, and alternatives.
      </p>
      <h3>When it is used</h3>
      <p>
        Only when <strong>RDF</strong> is delivered (Outputs tab) and at least one{' '}
        <strong>vocabulary</strong> is pinned (Survey tab); otherwise the stage is not used. It goes
        out of date when the outputs or the pinned ontologies change.
      </p>
      <Proposals />
      <h3>Reviewing the proposal</h3>
      <p>
        The tab shows the same outline as the Recipe tab&apos;s Mapping. Each output the proposal
        changes is marked <strong>NEW</strong> or <strong>CHANGED</strong> and has a checkbox; pick
        one to see the mapping now beside the proposed one, the model&apos;s confidence and reason,
        the values seen in the samples and the terms it was chosen over. A column changed with its
        table is applied with the table. <strong>Proposed</strong> and <strong>Unmapped</strong>{' '}
        narrow the outline, and the line below counts the outputs mapped now and after applying the
        selected changes.
      </p>
      <p>
        Once you apply or reject it, the outline shows the mapping as it is. At the top,{' '}
        <strong>Preview the graph</strong> renders a dev sample&apos;s graph with the applied
        mapping, and <strong>Latest proposal</strong> lists what the model proposed and which
        changes were applied.
      </p>
      <p>Edit the mapping by hand on the Recipe tab's Mapping, which also previews the graph.</p>
    </>
  );
}

export function WbReferencesHelp() {
  return (
    <>
      <p>
        A reference is a sample's correct answer: every output, checked by a person. Evaluation
        compares runs against them, so they decide the scores.
      </p>
      <h3>Making references</h3>
      <ol>
        <li>Start a reference run: the sample goes through the draft and stops for review.</li>
        <li>Correct the values in review and approve. Nothing is delivered.</li>
        <li>
          <strong>Save as reference</strong> on the finished run marks the sample verified.
        </li>
      </ol>
      <p>
        Dev samples run on the drafting model; holdout samples on the recipe's own models, so the
        holdout stays unseen by drafting. The stage is done once every ready dev sample is verified.
      </p>
      <h3>Out of date and Re-verify</h3>
      <p>
        Changing an output (its type, values or columns) makes the references that include it out of
        date. <strong>Re-verify…</strong> runs the sample again so you can check it.
      </p>
      <h3>Right first time</h3>
      <p>How often the model's value needed no correction, per output: where to improve first.</p>
    </>
  );
}

export function WbEvaluateHelp() {
  return (
    <>
      <p>Evaluate runs the draft on samples with references and scores each output against them.</p>
      <h3>Dev and holdout</h3>
      <ul>
        <li>
          <strong>Dev</strong>: for working on the recipe. You can comment on the results, and{' '}
          <strong>Compare</strong> runs the same samples on several models to choose between them.
        </li>
        <li>
          <strong>Holdout</strong>: the fair test before publishing, always on the recipe's own
          models; its details stay sealed so drafting never learns from them.
        </li>
      </ul>
      <h3>The publish gate</h3>
      <p>
        The newest holdout run of the open draft decides it: did it cover every holdout sample, and
        is its score at or above the <strong>threshold</strong> (0.9 unless changed)? The gate is
        advice: you can publish either way, and the gate's result is recorded with the publication.
      </p>
      <h3>History</h3>
      <p>
        Each run is kept with the recipe it used. <strong>Restore</strong> puts an earlier run's
        recipe back into the draft.
      </p>
    </>
  );
}

export function WbReviseHelp() {
  return (
    <>
      <p>
        Revise improves the draft from your feedback and from the latest dev evaluation's failures.
      </p>
      <h3>Feedback</h3>
      <p>
        Write what is wrong or missing, one point at a time; each is numbered. The model's proposal
        says which points each change answers, and answered feedback is marked once applied.
      </p>
      <h3>What the model will see</h3>
      <p>
        Exactly what the next revision sends: your open feedback, the worst failures of the latest
        dev run, and the draft. <strong>Not sent</strong> lists what stays back, such as anything
        from holdout samples.
      </p>
      <h3>Run diagnostics</h3>
      <p>
        Revise also sends what the latest dev runs of this draft showed: steps whose calls mostly
        returned no rows, values that did not fit their columns, and headings that matched no
        anchor. You can ask for a revision from diagnostics alone, without writing feedback.
      </p>
      <h3>After applying</h3>
      <p>
        Evaluate the new draft on dev to see whether it helped; the footer warns before Apply when
        changes would add, remove or reshape outputs.
      </p>
    </>
  );
}

export function DraftModelLogHelp() {
  return (
    <>
      <p>
        A proposal's <strong>Model log</strong> shows what the drafting model was sent and what it
        did while it made the proposal: useful when a proposal looks wrong, or a stage failed.
      </p>
      <h3>Rounds and attempts</h3>
      <p>
        Each round is one go at the proposal. The Sections stage has a second, the{' '}
        <strong>anchor round</strong>, when anchors it proposed missed on the dev samples.
      </p>
      <p>
        The left of the log lists each round's <strong>attempts</strong>: an attempt ends when the
        model's answer is accepted (✓), rejected and sent back with the reasons (✗), or the run
        stops (!). Pick one to see it on the right: first the errors that sent it back, then what
        the model was sent, did and answered.
      </p>
      <h3>What an attempt holds</h3>
      <ul>
        <li>
          <strong>Prompt sent</strong>: everything the model read, the brief, the draft and the dev
          samples' text. Holdout samples are never in it.
        </li>
        <li>
          <strong>Reply</strong>: what it answered, with the tokens it used.
        </li>
        <li>
          <strong>Tool calls</strong>: when the model's endpoint allows tools, it can check its work
          before answering: try section anchors on the dev samples, read more pages of a dev sample,
          or search the pinned ontologies and look a term up. Each call shows what it asked for and
          what came back.
        </li>
        <li>
          <strong>Answer rejected</strong>: an answer that broke the recipe's rules, with the
          reasons the model was given to fix it.
        </li>
        <li>
          <strong>Stopped</strong>: why a failed run ended.
        </li>
      </ul>
      <p>
        Runs from before the full log show prompts, replies and rejections only. An admin turns tool
        calls off for an endpoint under Administration &gt; Models.
      </p>
    </>
  );
}

export function WbRecipeHelp() {
  return (
    <>
      <p>
        The draft recipe itself, in the full editor. Each of its tabs (General, Sections, Outputs,
        Pipeline, Mapping, YAML, Versions) has its own ?.
      </p>
      <h3>Above the editor</h3>
      <ul>
        <li>
          <strong>Try on</strong>: run the saved draft on one dev sample. It waits while edits are
          unsaved or the draft has problems.
        </li>
        <li>
          The checks list what needs fixing (an output no step fills, an invalid setting), each
          linked to its tab.
        </li>
        <li>
          The change log lists every change to this draft: by hand, applied from a proposal,
          restored, or imported, with a full diff.
        </li>
      </ul>
      <h3>Publish</h3>
      <p>
        <strong>Publish vN</strong> makes the draft the version new documents use, recording the
        publish gate's result. Published versions never change; the next draft starts from them.
      </p>
    </>
  );
}

export function WbRunsHelp() {
  return (
    <>
      <p>
        Run the draft on dev samples and see how each document went. Test runs go through review
        like real jobs but are never delivered.
      </p>
      <h3>Running</h3>
      <p>
        Tick the samples (ready dev samples are ticked to start with), then{' '}
        <strong>Run on n dev samples</strong>; pick the model in the dialog. The queue line says how
        many jobs are ahead and roughly how long it will take.
      </p>
      <h3>Batches</h3>
      <p>
        Each run is a batch, newest first: a bar of its jobs' states, and a row per sample with its
        status, the step it is on, and how long it took. <strong>Review</strong> opens a finished
        run; <strong>Retry</strong> runs a failed one again. Older batches are behind{' '}
        <strong>Show</strong>.
      </p>
      <h3>Cancelling</h3>
      <p>
        <strong>Cancel</strong> on a queued or running row stops that run, and{' '}
        <strong>Cancel batch…</strong> stops every run of the batch that has not finished; both ask
        first. A running run stops at its next safe point, finished runs are left as they are, and a
        cancelled run can be retried.
      </p>
    </>
  );
}

export function ReviewHelp() {
  return (
    <>
      <p>
        Check what was extracted from one document, correct anything wrong, then approve it for
        publishing or reject it.
      </p>
      <h3>At the top</h3>
      <p>
        The document, its recipe version, status and model; how many documents await review and{' '}
        <strong>Next document</strong>. <strong>Why this needs review</strong> lists what flagged
        it, such as values that could not be read as their type or checks that did not match.
      </p>
      <h3>The document and the data</h3>
      <p>
        The pages of the document sit beside the extracted values. Each value shows the{' '}
        <strong>evidence</strong> the model quoted and the page it came from, where it gave one;
        flagged values are highlighted. Click a value to correct it.
      </p>
      <h3>Arranging the page</h3>
      <ul>
        <li>
          Drag the divider between the document and the data (or focus it and use the arrow keys) to
          give either more room; <strong>30 / 70</strong>, <strong>40 / 60</strong> and{' '}
          <strong>50 / 50</strong> set the document's share at once.
        </li>
        <li>
          The arrow at the right of each panel's header folds it to a narrow strip at its side; the
          strip's arrow brings it back. <strong>Swap sides</strong> puts the document on the other
          side. CT Studio remembers the arrangement in this browser.
        </li>
        <li>
          The thumbnails beside the page open any page; a dot marks a page holding a flagged field.
        </li>
      </ul>
      <h3>Finding a value</h3>
      <ul>
        <li>
          The list on the left of the data holds <strong>Fields</strong>, each table (its name, with
          its reference such as <em>Table IX</em> below it) and, under Review, Edits, Steps and
          Graph. Each shows how many values it has and, in amber, how many are flagged.{' '}
          <strong>Find a table or field</strong> narrows the list.
        </li>
        <li>
          <strong>Next flagged</strong> steps through every flagged value. On a table cell, the
          strip under the table says why it was flagged; <strong>Edit value</strong> opens it for
          correction.
        </li>
        <li>
          A table shows <strong>All rows</strong> or <strong>Flagged only</strong>; ‹ › step to the
          table before or after.
        </li>
      </ul>
      <h3>Tabs</h3>
      <ul>
        <li>
          <strong>Fields</strong> and each table: the values to check.
        </li>
        <li>
          <strong>Steps</strong>: how each extraction and plugin step ran. <strong>Re-run</strong> a
          step with extra guidance, other pages shown as images, or another model, when a whole step
          got it wrong. A plugin step takes guidance (the plugin reads it), a model only when its
          plugin asks one, and no page images. <strong>Model log</strong> shows each attempt of a
          step in this job: the prompt, the model's reply and the errors that sent a reply back.
        </li>
        <li>
          <strong>Graph</strong> (linked data): the graph and any rules it breaks, as cards, a
          diagram or Turtle (see <em>Reading a graph</em>).
        </li>
      </ul>
      <h3>Deciding</h3>
      <p>
        <strong>Approve</strong> (with an optional note) publishes the corrected values; for a test
        run it only finishes the review. <strong>Reject</strong> needs a reason and is final.
      </p>
    </>
  );
}

export function GraphViewsHelp() {
  return (
    <>
      <p>
        When a recipe delivers RDF, each document becomes a graph of linked data. You see it in
        three places, all read the same way:
      </p>
      <ul>
        <li>
          <strong>Review</strong>, the <strong>Graph</strong> tab: the graph this document will
          publish, and the rules (shapes) it breaks if the recipe pins any. Each result says what is
          wrong; <strong>Show</strong> opens the field or table it is about, where you correct the
          value. The graph follows the corrected values when you approve.
        </li>
        <li>
          The recipe&apos;s <strong>Mapping</strong> preview: the saved mapping over each dev
          sample&apos;s newest test run, before anything is published.
        </li>
        <li>
          A published <strong>result</strong>, its <strong>Graph</strong> item: the graph as it was
          delivered.
        </li>
      </ul>
      <h3>Three views</h3>
      <ul>
        <li>
          <strong>Cards</strong> (the default): one card per thing the graph describes, the document
          first and then what it links to. Types and properties use the names your pinned ontologies
          give them; dates and yes/no values are spelled out, and a value with a unit reads as one
          value (<em>12.5 kg</em>). Under a value, the page and the quote it was read from. A blue
          chip is another card: click it to go there; <em>Linked from</em> goes back. A rule the
          value breaks is shown on its row in red, and a value a rule needs but the graph lacks is a{' '}
          <em>Missing</em> row.
        </li>
        <li>
          <strong>Diagram</strong>: the same things as boxes and their links as arrows, the document
          in the accent colour, a box with a broken rule outlined in red. Pick a box, or a name in
          the list, to see its card beside the diagram. Drag to move, scroll to zoom.
        </li>
        <li>
          <strong>Turtle</strong>: the graph as it is published, for checking the exact terms. A
          graph that cannot be read is always shown this way.
        </li>
      </ul>
      <p>
        Pages, sections, quotes and the run that made the graph are part of it too (its provenance);
        the cards show them beside the values instead of as cards of their own. The view you pick is
        remembered.
      </p>
    </>
  );
}
