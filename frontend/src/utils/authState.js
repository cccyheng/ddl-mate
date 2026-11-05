import { reactive } from 'vue'

/** 登录状态（只在服务器版启用登录时有意义）。 */
export const authState = reactive({
  checked: false,
  enabled: false,
  authenticated: false,
  username: '',
  setupAvailable: false,
  registrationEnabled: false,
  /** 用临时密码登录：必须先去「账号与安全」改密码。 */
  mustChangePassword: false,
})
