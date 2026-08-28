require('user.options')
require('user.highlight_yank')
require('user.keymaps')
require('user.herdr_server')

vim.api.nvim_create_user_command('AvanteZen', function(_)
  vim.defer_fn(function() require("avante.api").zen_mode() end, 100)
end, { desc = 'Format current buffer with LSP' })

-- vim.api.nvim_create_user_command(bufnr, 'Format', function(_)
--   vim.lsp.buf.format()
-- end, { desc = 'Format current buffer with LSP' })
