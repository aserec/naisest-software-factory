import { fakeChat } from "../fakes";
import { chatContract } from "./chat.contract";

chatContract(() => fakeChat());
