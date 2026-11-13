import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { delay, i18n, request } from 'vj/utils';

const page = new NamedPage('manage_student_import', () => {
  async function post(draft) {
    try {
      const res = await request.post('', {
        students: $('[name="students"]').val(),
        draft,
      });
      $('[name="messages"]').text(res.messages.join('\n'));
      if (!draft) {
        Notification.success(i18n('Created {0} users.', res.created));
        if (!res.errors) {
          await delay(2000);
          window.location.reload();
        }
      }
    } catch (error) {
      Notification.error(error.message);
    }
  }

  $('[name="preview"]').on('click', () => post(true));
  $('[name="submit"]').on('click', () => post(false));
});

export default page;
