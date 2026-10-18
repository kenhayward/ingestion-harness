# Querying published data (SPARQL)

Content Transformation Studio (CT Studio) publishes every approved document whose recipe
delivers RDF to a triple store (Apache Jena Fuseki), as well as to S3. This page is for the
people and systems that read that data. Background: [ADR 0011](../adr/0011-rdf-publishing-and-ontologies.md).

## Endpoint and access

The Linked data page in CT Studio (admins) shows the endpoint. With the address of your
deployment's proxy as `https://sparql.example`, the endpoints are:

| What | URL | Method |
| --- | --- | --- |
| SPARQL 1.1 query | `https://sparql.example/ct/sparql` | `GET ?query=` or `POST` form `query=` |
| Graph Store Protocol (read) | `https://sparql.example/ct/get?graph=<graph IRI>` | `GET` |

- **Authentication:** HTTP basic, with the one shared read-only user `ct-reader`. Your CT Studio
  administrator gives you the password. Nothing can be written with it.
- **Formats:** ask with `Accept`, for example `application/sparql-results+json`, `text/csv`, or
  `text/turtle` for `CONSTRUCT` queries and graph reads.

```bash
curl -u ct-reader:$PASSWORD \
  -H 'Accept: application/sparql-results+json' \
  --data-urlencode 'query=SELECT (count(*) AS ?n) WHERE { ?s ?p ?o }' \
  https://sparql.example/ct/sparql
```

## What is in the store

- **One named graph per original document and document type:**
  `{base}graph/source/{sha256}/{type}`. The `sha256` identifies the uploaded file, so
  re-processing the same file replaces its graph rather than adding another. When one file is
  read by two document types, there are two graphs, both describing the same document node
  `{base}doc/{sha256}`.
- **Ontologies:** every ontology the recipes map to is loaded as its own graph,
  `{base}graph/ontology/{id}/{version}`, so its classes, labels and hierarchies can be queried
  with the data.
- **The default graph is the union of all graphs.** A query without `GRAPH` sees everything.
  Use `GRAPH ?g { … }` to learn which document (and type) a statement came from.
- **Value nodes:** where a recipe maps a measurement to a class (ontologies such as Allotrope and
  OBI put the meaning in classes), the value sits on a node of that class, linked from its
  document or table row, holding the value and, when it has one, its unit. Several of a row's
  values may share a class (minimum and maximum of one quantity): `ct:output` on each node names
  the recipe output it publishes.
- `{base}` is your organisation's base IRI, also shown on the Linked data page.

## Rules for consumers

1. **IRIs are identifiers, not data.** Find documents and entities by their values: their
   `rdfs:label`, the properties the ontology defines and their literals. Never parse meaning out
   of an IRI, even when it looks readable (`batch/site-1/pv-2301`). The way IRIs are minted may
   change; the values will not.
2. **Expect replacements and withdrawals.** A graph is replaced when its document is published
   again (a correction, a newer recipe), and it disappears when the job is deleted or the
   document type retired. Read the current state; don't cache IRIs as if they were permanent
   records of a version.
3. **Overlaps are visible, not resolved.** Two document types may state the same property of
   the same document. Both values are present, and `GRAPH ?g` tells them apart.

## Provenance, evidence and versions

Each graph says how it was made:

- **Document node:** `prov:wasGeneratedBy` points to the job that produced it, and
  `dcterms:source` to `urn:sha256:{sha256}`.
- **Job node** (`prov:Activity`): carries `ct:recipe`, `ct:recipeVersion`, the model choices
  used (`ct:model`), the reviewer (`ct:reviewedBy`), the base IRI (`ct:baseIri`) and
  `prov:endedAtTime`.
- **Each value:** a `ct:Evidence` node (`ct:subject`, `ct:property`, `ct:value`) with the page
  (`ct:page`, a `ct:Page` with `ct:pageNumber`), the quoted text (`ct:quote`), the section and
  the extraction step (`ct:step`). Values that failed normalisation carry
  `ct:normalisationIssue`.
- **The graph:** `<graph IRI> ct:graphVersion n ; dcterms:modified t`. Each publish of the same
  document and type is the next version.

The `ct:` namespace is `https://id.stocks-hayward.com/ns/ct#`.

## Example queries

Documents of one class, with when they were published:

```sparql
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX ct: <https://id.stocks-hayward.com/ns/ct#>
SELECT ?doc ?g ?version ?modified WHERE {
  GRAPH ?g { ?doc a <https://acme.example/def/ProcessValidationProtocol> . }
  ?g ct:graphVersion ?version ; dcterms:modified ?modified .
}
```

An entity found by its value, never by its IRI:

```sparql
PREFIX acme: <https://acme.example/def/>
SELECT ?batch ?doc WHERE {
  ?batch acme:batchNumber "PV-2301" .
  ?doc ?p ?batch .
}
```

Measurements by class, with their unit and the row they belong to (a recipe mapping them as value
nodes; the link and value properties are the ones the recipe chose):

```sparql
PREFIX afr: <http://purl.allotrope.org/ontologies/result#>
PREFIX obo: <http://purl.obolibrary.org/obo/>
PREFIX qudt: <http://qudt.org/schema/qudt/>
SELECT ?row ?value ?unit WHERE {
  ?row obo:OBI_0000299 ?node .
  ?node a afr:AFR_0002445 ; qudt:numericValue ?value .
  OPTIONAL { ?node qudt:unit ?unit }
}
```

Where a value came from (page and quote):

```sparql
PREFIX ct: <https://id.stocks-hayward.com/ns/ct#>
SELECT ?property ?value ?page ?quote WHERE {
  ?e a ct:Evidence ; ct:subject ?doc ; ct:property ?property ; ct:value ?value .
  OPTIONAL { ?e ct:page/ct:pageNumber ?page }
  OPTIONAL { ?e ct:quote ?quote }
  FILTER (?doc = <https://data.acme.example/doc/9f2…>)
}
```

One document's whole graph, as Turtle:

```bash
curl -u ct-reader:$PASSWORD -H 'Accept: text/turtle' \
  'https://sparql.example/ct/get?graph=https://data.acme.example/graph/source/9f2…/process-validation-protocol'
```
