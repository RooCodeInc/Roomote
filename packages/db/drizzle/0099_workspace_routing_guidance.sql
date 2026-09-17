UPDATE "deployment_settings" AS settings
SET "workspace_routing_settings" = settings."workspace_routing_settings" || jsonb_build_object(
	'guidance',
	COALESCE((
		SELECT string_agg(
			'- ' || (rule.value->>'description') || ' -> Use ' ||
			CASE
				WHEN (rule.value->>'target') = '__all_repositories__' THEN 'All repositories'
				WHEN environment."id" IS NOT NULL THEN 'the "' || environment."name" || '" environment'
				ELSE 'environment "' || (rule.value->>'target') || '"'
			END || '.',
			E'\n' ORDER BY rule.ordinality
		)
		FROM jsonb_array_elements(settings."workspace_routing_settings"->'rules')
			WITH ORDINALITY AS rule(value, ordinality)
		LEFT JOIN "environments" AS environment
			ON environment."id"::text = (rule.value->>'target')
	), '')
)
WHERE jsonb_typeof(settings."workspace_routing_settings") = 'object'
	AND settings."workspace_routing_settings" ? 'rules'
	AND NOT settings."workspace_routing_settings" ? 'guidance';
