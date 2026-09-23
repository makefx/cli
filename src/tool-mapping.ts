/**
 * The dedicated shell command responsible for each public MCP tool.
 *
 * Keep this list beside the dispatcher: its test compares these reviewed
 * decisions with MCP_TOOLS so a new public tool cannot silently rely on the
 * generic `makefx mcp` bridge.
 */
export const CLI_MCP_TOOL_MAPPING = {
  create_credit_purchase: 'purchase create',
  get_credit_purchase: 'purchase get',
  get_account: 'account',
  create_asset: 'create',
  upload_asset: 'upload',
  create_space: 'space create',
  update_space: 'space update',
  delete_space: 'space delete',
  get_space: 'space get',
  export_space: 'export',
  get_asset: 'asset get',
  update_asset: 'asset update',
  describe_asset: 'describe',
  align_audio: 'audio align',
  get_audio_word_timings: 'audio timings',
  delete_asset: 'asset delete',
  link_assets: 'link',
  unlink_assets: 'unlink',
  get_profile: 'profile get',
  update_profile: 'profile update',
  health_check: 'health',
  list_spaces: 'spaces',
  list_models: 'models',
  sync_voices: 'voices sync',
  estimate_credits: 'estimate',
} as const;

/** Product-approved exceptions must name the tool and explain why no shell command exists. */
export const CLI_MCP_TOOL_EXCEPTIONS: Readonly<Record<string, string>> = {};
