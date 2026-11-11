{{- define "yardhand.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "yardhand.labels" -}}
app.kubernetes.io/name: yardhand
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "yardhand.selector" -}}
app.kubernetes.io/name: yardhand
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "yardhand.claim" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-state" (include "yardhand.name" .)) -}}
{{- end -}}
