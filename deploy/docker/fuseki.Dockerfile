# Apache Jena Fuseki (ADR 0011 step 6), built from the release jar on Maven Central, checked
# against its sha512. Build context: repo root.
FROM eclipse-temurin:24.0.2_12-jre
ARG FUSEKI_VERSION=6.2.0
ARG FUSEKI_SHA512=59c5d0fd4e3f2c51819816dd178ee7d619552aae12400286338cc55c6955653e6c503d58b6cb12f3124407c903a81a2ecf4a9b0d5ba8028e7fcdc7c5c98710d4
RUN mkdir -p /opt/fuseki /fuseki \
 && curl -fsSL -o /opt/fuseki/fuseki-server.jar \
      "https://repo1.maven.org/maven2/org/apache/jena/jena-fuseki-server/${FUSEKI_VERSION}/jena-fuseki-server-${FUSEKI_VERSION}.jar" \
 && echo "${FUSEKI_SHA512}  /opt/fuseki/fuseki-server.jar" | sha512sum -c - \
 && chown ubuntu:ubuntu /fuseki
COPY deploy/fuseki/config.ttl /opt/fuseki/config.ttl
COPY --chmod=755 deploy/fuseki/entrypoint.sh deploy/fuseki/admin.sh /opt/fuseki/
USER ubuntu
VOLUME /fuseki
EXPOSE 3030
ENTRYPOINT ["/opt/fuseki/entrypoint.sh"]
