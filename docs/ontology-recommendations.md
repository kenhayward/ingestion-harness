# Recommended ontologies for the library

Which ontologies Content Transformation Studio (CT Studio) should hold in its ontology library
([ADR 0011](adr/0011-rdf-publishing-and-ontologies.md)), in three groups:

1. general-purpose W3C and standards-body vocabularies;
2. the core pharmaceutical ontologies;
3. a short list to hold back because of licensing or size.

Compiled 2026-10-15. Versions move, IDMP-O especially, so check the current release before
pinning one.

## Licensing comes first

When a published recipe pins an ontology version, publishing loads that version into Fuseki as
its own graph, `{base}graph/ontology/{id}/{version}`. The shared `ct-reader` user, and so the
customer, can read every graph. **Only pin ontologies whose licence allows redistribution to
the customer.**

## Library limits

- **Size:** the library refuses an import above 2,000,000 triples (`ONTOLOGY_MAX_TRIPLES`).
- **Allowed hosts:** a URL import works only for hosts listed in `ONTOLOGY_FETCH_ALLOW`.
- **Redirects:** each redirect is checked against that list too, so also allow the hosts a link
  redirects to (for example `raw.githubusercontent.com`).

## 1. General-purpose: import these first

| Ontology | Why we want it | Download | Licence |
| --- | --- | --- | --- |
| SKOS | Code lists and enum values mapped to concepts (`match: label`) | https://www.w3.org/2004/02/skos/core.rdf | W3C |
| DCMI Terms | Document metadata: title, issued, source | https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl | CC BY 4.0 |
| PROV-O | We already emit `prov:` terms; lets consumers browse them | https://www.w3.org/ns/prov-o | W3C |
| OWL-Time | Dates, periods and durations (shelf life, validity) | https://www.w3.org/2006/time | W3C |
| W3C Organization | Manufacturers, sites, marketing authorisation holders | https://www.w3.org/ns/org | W3C |
| QUDT | Units and quantity kinds (mg, mL, °C) | Units: https://qudt.org/2.1/vocab/unit · schema: https://qudt.org/2.1/schema/qudt ([catalog](https://www.qudt.org/2.1/catalog/qudt-catalog.html); version 3.x is current on [qudt.org](https://qudt.org/pages/QUDToverviewPage.html)) | CC BY 4.0 |
| GS1 Web Vocabulary | Product identifiers (GTIN), batch and lot, packaging; extends schema.org | https://ref.gs1.org/voc/data/gs1Voc.ttl ([repo](https://github.com/gs1/WebVoc)) | Apache 2.0 |
| schema.org (optional) | A broad fallback vocabulary; large, so import only if recipes use it | https://schema.org/version/latest/schemaorg-current-https.ttl | CC BY-SA 3.0 |

You don't need to import RDF, RDFS, OWL, XSD or SHACL: their prefixes are built in
(`CURIE_PREFIXES`).

## 2. Pharmaceutical core

| Ontology | Why we want it | Download | Licence and notes |
| --- | --- | --- | --- |
| IDMP-O (Pistoia Alliance), the anchor for the product and substance model | ISO IDMP: medicinal product, substance, pharmaceutical product, packaging, authorisation. It fits EMA SPOR data and process validation documents best | https://github.com/Pistoia-Alliance-Inc/Pistoia-Alliance-Ontologies/tree/main/IDMP-O · EDM Council copy: https://github.com/edmcouncil/idmp, https://spec.edmcouncil.org/idmp/page/owl | MIT. Access is tiered ([information sheet](https://pistoiaalliance.org/wp-content/uploads/2026/08/2026-08-06_IDMP-Ontology-Information-Sheet.pdf)): funding members get the newest releases first ([v1.6 release](https://pistoiaalliance.org/?p=29275)), and the public tier lags behind. Check which version you're entitled to; idmpo@PistoiaAlliance.org can give access to the latest. |
| Allotrope Foundation Ontologies (AFO) | Lab and analytical data: methods, instruments, results, samples. A strong match for test results and process validation tables | http://purl.allotrope.org/voc/afo/latest.xml · https://www.allotrope.org/ontologies | CC BY, but a few terms carry other licences (CC BY-SA from Wikipedia). Check the attribution file in the release ([BioPortal](https://bioportal.bioontology.org/ontologies/AFO)). |
| ChEBI | Chemical entities: active substances, excipients | http://purl.obolibrary.org/obo/chebi.owl ([Ontobee](https://ontobee.org/ontology/CHEBI)) | CC BY 4.0. The full file is likely well over the 2M-triple cap: import a subset, such as ChEBI's lite release or an extract of the terms you use. |
| OBI | Assays, protocols, specimens: the context for validation experiments | http://purl.obolibrary.org/obo/obi.owl ([BioPortal](https://bioportal.bioontology.org/ontologies/OBI?p=summary)) | CC BY 4.0. It imports BFO and IAO, which `owl:imports` resolution handles automatically. |
| UO (units, OBO) | An alternative to QUDT if you use OBO ontologies | http://purl.obolibrary.org/obo/uo.owl | CC BY. This link follows the standard OBO pattern but couldn't be confirmed; check the [OBO Foundry registry](https://obofoundry.org/). |
| CDISC Controlled Terminology (OWL) | Clinical and non-clinical code lists (SDTM, SEND), for clinical documents | NCI EVS publishes CDISC terminology as OWL (https://evs.nci.nih.gov/ftp1/CDISC/) · older PhUSE model: https://github.com/phuse-org/rdf.cdisc.org | Free to use. The PhUSE repository dates from around 2014–15, so use the NCI EVS files for current terminology. |

## 3. Hold these back: licensed, size-limited, or not RDF

- **EDQM Standard Terms** (dose forms, routes of administration, containers):
  - **Why it matters:** this is the IDMP standard for those code lists, and IDMP-O expects it.
  - **Access:** free after registering at https://standardterms.edqm.eu
    ([EDQM](https://edqm.eu/standard-terms-database)).
  - **Catch:** the terms are EDQM copyright and come as JSON through an API, not as RDF.
  - **What to do:** convert them to SKOS, and only pin them once their redistribution terms
    allow it.
- **NCI Thesaurus, MeSH:** free, but far over the 2M-triple cap. Import extracts only.
- **SNOMED CT, MedDRA, WHO ATC, RxNorm:** these need licences, and loading them into Fuseki
  would expose them to the customer's readers. Keep them out unless the customer holds the
  licence and accepts that exposure.

## What to do first

1. Import group 1 now, plus IDMP-O, AFO and OBI (which brings BFO and IAO with it).
2. Pin IDMP-O and QUDT in the Process Validation Protocol brief, and let the mapping stage
   propose terms.
3. Add ChEBI as a subset only once recipes need substance-level identity.
4. Set the allowed hosts:

   ```
   ONTOLOGY_FETCH_ALLOW=www.w3.org,purl.obolibrary.org,raw.githubusercontent.com,github.com,purl.allotrope.org,qudt.org,ref.gs1.org,www.dublincore.org
   ```

   Test each URL import once, because redirect chains vary by host.

## How reliable the links are

- **Checked against current sources** (listed below): most links in this document.
- **Not re-checked on 2026-10-15:** the PROV-O, OWL-Time, W3C Organization and DCMI Terms links,
  and the NCI EVS CDISC folder. They are well-known addresses.
- **Unconfirmed:** the UO link.

## Sources

- [Pistoia Alliance: IDMP Ontology information sheet](https://pistoiaalliance.org/wp-content/uploads/2026/08/2026-08-06_IDMP-Ontology-Information-Sheet.pdf)
- [Pistoia Alliance: IDMP-O v1.6 release](https://pistoiaalliance.org/?p=29275)
- [Pistoia Alliance: IDMP-O 1.0 launch](https://pistoiaalliance.org/?p=19998)
- [EDM Council: IDMP Ontology releases](https://dil-edmcouncil.atlassian.net/wiki/x/0JBu)
- [BioPortal: AFO](https://bioportal.bioontology.org/ontologies/AFO)
- [Ontobee: AFO](https://ontobee.org/ontology/AFO)
- [Bioregistry: AFO](https://bioregistry.io/afo)
- [QUDT 2.1 catalog](https://www.qudt.org/2.1/catalog/qudt-catalog.html)
- [QUDT overview](https://qudt.org/pages/QUDToverviewPage.html)
- [Dublin Core: QUDT](https://msi.dublincore.org/standards/qudt)
- [Ontobee: ChEBI](https://ontobee.org/ontology/CHEBI)
- [BioPortal: OBI](https://bioportal.bioontology.org/ontologies/OBI?p=summary)
- [List of OBO Foundry ontologies](https://en.wikipedia.org/wiki/List_of_OBO_Foundry_ontologies)
- [GS1 Web Vocabulary](https://ref.gs1.org/voc/)
- [GS1 vocabulary archive](https://ref.gs1.org/voc/data/archive)
- [GS1 WebVoc on GitHub](https://github.com/gs1/WebVoc)
- [EDQM Standard Terms database](https://edqm.eu/standard-terms-database)
- [Oracle Argus: downloading EDQM lists](https://docs.oracle.com/en/industries/health-sciences/argus-safety/8.4/edqbp/download-edqm-standard-list-dose-formulation-and-routes-administration.html)
- [EMA: EDQM terminologies in E2B(R3)](https://wwW.ema.europa.eu/en/documents/other/use-edqm-terminologies-dose-forms-and-routes-administration-individual-case-safety-reports-e2br3-message_en.pdf)
- [PhUSE/CDISC RDF discussion (W3C list)](https://lists.w3.org/Archives/Public/public-semweb-lifesci/2015Jan/0010.html)
- [CDISC RDF reference guide webinar](https://lists.w3.org/Archives/Public/www-archive/2015Jan/att-0001/CDISC_Webinar_2014-07-24_RDF_Reference_Guide.pdf)
