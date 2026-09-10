{{- define "caelestis.name" -}}
{{- printf "%s-caelestis" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "caelestis.labels" -}}
app.kubernetes.io/name: caelestis
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "caelestis.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ default .Chart.AppVersion .Values.image.tag }}
{{- end -}}
{{- end -}}
{{- define "caelestis.pod" -}}
{{- if and (not .Values.persistence.enabled) (or (eq .Values.database.adapter "sqlite") (eq .Values.storage.adapter "filesystem")) -}}
{{- fail "SQLite and filesystem storage require persistence.enabled=true" -}}
{{- end -}}
automountServiceAccountToken: false
terminationGracePeriodSeconds: 45
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: caelestis
    image: {{ include "caelestis.image" . | quote }}
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    {{- if .Values.migration.enabled }}
    command: [node, apps/backend/dist/node/main.js, migrate]
    {{- else }}
    ports:
      - name: http
        containerPort: 3000
    startupProbe:
      httpGet: { path: /health/ready, port: http }
      failureThreshold: 60
      periodSeconds: 5
    readinessProbe:
      httpGet: { path: /health/ready, port: http }
      periodSeconds: 10
    livenessProbe:
      httpGet: { path: /health/live, port: http }
      periodSeconds: 10
    {{- end }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: [ALL] }
    resources: {{ toYaml .Values.resources | nindent 6 }}
    {{- if or .Values.server.existingSecret .Values.storage.s3.existingSecret }}
    envFrom:
      {{- with .Values.server.existingSecret }}
      - secretRef: { name: {{ . | quote }} }
      {{- end }}
      {{- with .Values.storage.s3.existingSecret }}
      - secretRef: { name: {{ . | quote }} }
      {{- end }}
    {{- end }}
    env:
      - { name: REPLICAS, value: '1' }
      - { name: DB_ADAPTER, value: {{ .Values.database.adapter | quote }} }
      - { name: OBJECT_STORAGE, value: {{ .Values.storage.adapter | quote }} }
      - { name: SERVER_NAME, value: {{ .Values.server.name | quote }} }
      - { name: SEASON, value: {{ .Values.server.season | quote }} }
      - { name: OPEN_ACCESS, value: {{ .Values.server.openAccess | quote }} }
      - { name: BASE_PATH, value: {{ .Values.server.basePath | quote }} }
      {{- with .Values.server.origin }}
      - { name: ORIGIN, value: {{ . | quote }} }
      {{- end }}
      {{- with .Values.server.description }}
      - { name: SERVER_DESCRIPTION, value: {{ . | quote }} }
      {{- end }}
      {{- if eq .Values.database.adapter "postgres" }}
      - { name: PGHOST, value: {{ required "database.host must name the PostgreSQL primary service" .Values.database.host | quote }} }
      - { name: PGPORT, value: {{ .Values.database.port | quote }} }
      - { name: PG_TLS_MODE, value: {{ .Values.database.tls.mode | quote }} }
      {{- range $name, $key := dict "PGUSER" .Values.database.secretKeys.username "PGPASSWORD" .Values.database.secretKeys.password "PGDATABASE" .Values.database.secretKeys.database }}
      - name: {{ $name }}
        valueFrom:
          secretKeyRef:
            name: {{ required "database.existingSecret must contain application credentials" $.Values.database.existingSecret | quote }}
            key: {{ $key | quote }}
      {{- end }}
      {{- if .Values.database.tls.existingSecret }}
      - { name: PG_TLS_CA_FILE, value: /etc/caelestis/postgres/ca.crt }
      {{- end }}
      {{- end }}
      {{- if eq .Values.storage.adapter "s3" }}
      - { name: S3_BUCKET, value: {{ required "storage.s3.bucket is required" .Values.storage.s3.bucket | quote }} }
      - { name: S3_REGION, value: {{ .Values.storage.s3.region | quote }} }
      - { name: S3_FORCE_PATH_STYLE, value: {{ .Values.storage.s3.forcePathStyle | quote }} }
      {{- with .Values.storage.s3.endpoint }}
      - { name: S3_ENDPOINT, value: {{ . | quote }} }
      {{- end }}
      {{- end }}
      {{- with .Values.extraEnv }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    volumeMounts:
      - { name: data, mountPath: /data }
      - { name: tmp, mountPath: /tmp }
      {{- if .Values.database.tls.existingSecret }}
      - { name: postgres-ca, mountPath: /etc/caelestis/postgres, readOnly: true }
      {{- end }}
volumes:
  - name: data
    {{- if .Values.persistence.enabled }}
    persistentVolumeClaim:
      claimName: {{ default (include "caelestis.name" .) .Values.persistence.existingClaim }}
    {{- else }}
    emptyDir: {}
    {{- end }}
  - name: tmp
    emptyDir: {}
  {{- if .Values.database.tls.existingSecret }}
  - name: postgres-ca
    secret:
      secretName: {{ .Values.database.tls.existingSecret | quote }}
      items:
        - { key: {{ .Values.database.tls.caKey | quote }}, path: ca.crt }
  {{- end }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
