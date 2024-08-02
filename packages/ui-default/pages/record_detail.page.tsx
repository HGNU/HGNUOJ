import $ from 'jquery';
import React from 'react';
import { InfoDialog } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { tpl } from 'vj/utils';

export default new NamedPage('record_detail', async () => {
  if (!UiContext.socketUrl) return;
  const [{ default: WebSocket }, { DiffDOM }] = await Promise.all([
    import('../components/socket'),
    import('diff-dom'),
  ]);

  const sock = new WebSocket(UiContext.ws_prefix + UiContext.socketUrl, false, true);
  const dd = new DiffDOM();
  sock.onmessage = (_, data) => {
    const msg = JSON.parse(data);
    const newStatus = $(msg.status_html);
    const oldStatus = $('#status');
    dd.apply(oldStatus[0], dd.diff(oldStatus[0], newStatus[0]));
    const newSummary = $(msg.summary_html);
    const oldSummary = $('#summary');
    dd.apply(oldSummary[0], dd.diff(oldSummary[0], newSummary[0]));
    if (typeof msg.status === 'number' && window.parent) window.parent.postMessage({ status: msg.status });
  };
  $(document).on('click', '.subtask-case', function () {
    const data = $(this).find('.message').text();
    if (!data?.trim()) return;
    new InfoDialog({
      $body: tpl(<pre>{data}</pre>),
    }).open();
  });
});
